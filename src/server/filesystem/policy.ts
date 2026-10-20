import * as fs from "node:fs/promises"
import path from "node:path"
import { errorCode, WorkspaceError } from "../../shared/errors.ts"
import { CATALOG_LIMITS } from "../../shared/limits.ts"
import { expandPath, isInside, pathKey, resolvePath, slash } from "./paths.ts"

type RootPath = { path: string }

const DENIED_PART = /^(?:\.ssh|\.aws|\.env)(?:$)|^\.env\.|\.env$|\.pem$/i
const MISSING_OR_INACCESSIBLE_CODES = [
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
  "EBUSY",
  "ENAMETOOLONG",
]

export function assertNotDenied(value: string) {
  const denied = slash(value)
    .split("/")
    .some((part) => DENIED_PART.test(part))
  if (denied) throw new WorkspaceError("DENIED_PATH", "Sensitive workspace paths are blocked")
}

export const isMissingOrInaccessible = (error: unknown) =>
  MISSING_OR_INACCESSIBLE_CODES.includes(errorCode(error) ?? "")

export async function canonicalDirectory(raw: string, base: string) {
  const candidate = resolvePath(raw, base)
  assertNotDenied(candidate)
  const canonical = resolvePath(await fs.realpath(candidate), base)
  assertNotDenied(canonical)
  if (!(await fs.stat(canonical)).isDirectory())
    throw new WorkspaceError("NOT_DIRECTORY", candidate)
  return canonical
}

// Resolves a target that may not exist yet through its nearest existing ancestor.
export async function canonicalTarget(candidate: string) {
  let ancestor = candidate
  const suffix: string[] = []
  while (true) {
    try {
      return slash(path.join(await fs.realpath(ancestor), ...suffix))
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
      const next = path.dirname(ancestor)
      if (next === ancestor) throw error
      suffix.unshift(path.basename(ancestor))
      ancestor = next
    }
  }
}

export async function overlapsRoots(candidate: string, roots: readonly RootPath[]) {
  const overlaps = (target: string) =>
    roots.some((root) => isInside(root.path, target) || isInside(target, root.path))
  if (overlaps(candidate)) return true
  try {
    return overlaps(await canonicalTarget(candidate))
  } catch (error) {
    if (isMissingOrInaccessible(error)) return false
    throw error
  }
}

// The most specific registered root that contains the candidate, if any.
function owningRoot(candidate: string, roots: readonly RootPath[]) {
  return [...roots]
    .sort((first, second) => second.path.length - first.path.length)
    .find((root) => isInside(root.path, candidate))
}

async function assertRootUnchanged(root: RootPath) {
  const canonical = await canonicalDirectory(root.path, root.path)
  if (pathKey(canonical) !== pathKey(root.path)) throw new WorkspaceError("ROOT_CHANGED", root.path)
}

export async function checkedTarget(raw: string, roots: readonly RootPath[]) {
  const value = expandPath(raw)
  if (!path.isAbsolute(value))
    throw new WorkspaceError(
      "INVALID_PATH",
      "Native file tools require absolute paths; use workspace_resolve for aliases",
    )
  const candidate = resolvePath(value, path.parse(value).root)
  const root = owningRoot(candidate, roots)
  if (root) {
    assertNotDenied(candidate)
    await assertRootUnchanged(root)
  }
  let canonical: string
  try {
    canonical = await canonicalTarget(candidate)
  } catch (error) {
    if (!root && isMissingOrInaccessible(error)) return undefined
    throw error
  }
  if (!root && !roots.some((registered) => isInside(registered.path, canonical))) return undefined
  assertNotDenied(candidate)
  assertNotDenied(canonical)
  if (!root || !isInside(root.path, canonical) || pathKey(canonical) !== pathKey(candidate))
    throw new WorkspaceError(
      "OUTSIDE_ROOT",
      "Linked targets require explicit canonical registration",
    )
  return candidate
}

export function suggestedAlias(directory: string) {
  const alias = path
    .basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CATALOG_LIMITS.suggestedAliasLength)
  return alias || "root"
}
