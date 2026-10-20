import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { errorCode, WorkspaceError } from "../domain.ts"

export const slash = (value: string) => value.replaceAll("\\", "/")
export const pathKey = (value: string) => process.platform === "win32" ? slash(value).replace(/\/$/, "").toLowerCase() : slash(value).replace(/\/$/, "")
export function inside(root: string, candidate: string) {
  const relative = path.relative(process.platform === "win32" ? root.toLowerCase() : root, process.platform === "win32" ? candidate.toLowerCase() : candidate)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
export function expanded(raw: string) {
  let value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  value = slash(value).replace(/^~(?=\/|$)/, slash(homedir())).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, slash(homedir()))
  if (!value || /[\x00-\x1f\x7f]/.test(value) || /^\/\/[?.]\//.test(value) || value.startsWith("/??/")) throw new WorkspaceError("INVALID_PATH", "Empty, control-character, or device path")
  if (process.platform === "win32") {
    if (/^[a-z]:($|[^/])/i.test(value) || (value.startsWith("/") && !value.startsWith("//"))) throw new WorkspaceError("INVALID_PATH", "Use an absolute drive path")
    const suffix = value.replace(/^[a-z]:/i, "")
    if (/[<>:"|?*]/.test(suffix) || suffix.split("/").some((part) => part !== "." && part !== ".." && (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new WorkspaceError("INVALID_PATH", "Reserved Windows path component or alternate data stream")
  } else if (/^[a-z]:/i.test(value) || value.startsWith("//")) throw new WorkspaceError("INVALID_PATH", "Windows paths cannot be resolved on this server")
  return value
}
export function absolute(raw: string, base: string) { return slash(path.resolve(base, expanded(raw))) }
export function assertNotDenied(value: string) {
  if (slash(value).split("/").some((part) => /^(?:\.ssh|\.aws|\.env)(?:$)|^\.env\.|\.env$|\.pem$/i.test(part))) throw new WorkspaceError("DENIED_PATH", "Sensitive workspace paths are blocked")
}
export async function canonicalDirectory(raw: string, base: string) {
  const candidate = absolute(raw, base)
  assertNotDenied(candidate)
  const canonical = absolute(await fs.realpath(candidate), base)
  assertNotDenied(canonical)
  if (!(await fs.stat(canonical)).isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", candidate)
  return canonical
}
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
      suffix.unshift(path.basename(ancestor)); ancestor = next
    }
  }
}
const unavailable = (error: unknown) => ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EBUSY", "ENAMETOOLONG"].includes(errorCode(error) ?? "")
export async function overlapsRoots(candidate: string, roots: readonly { path: string }[]) {
  const overlaps = (target: string) => roots.some((root) => inside(root.path, target) || inside(target, root.path))
  if (overlaps(candidate)) return true
  try { return overlaps(await canonicalTarget(candidate)) } catch (error) {
    if (unavailable(error)) return false
    throw error
  }
}
export async function checkedTarget(raw: string, roots: readonly { path: string }[]) {
  const value = expanded(raw)
  if (!path.isAbsolute(value)) throw new WorkspaceError("INVALID_PATH", "Native file tools require absolute paths; use workspace_resolve for aliases")
  const candidate = absolute(value, path.parse(value).root)
  const root = [...roots].sort((first, second) => second.path.length - first.path.length).find((root) => inside(root.path, candidate))
  if (root) {
    assertNotDenied(candidate)
    if (pathKey(await canonicalDirectory(root.path, root.path)) !== pathKey(root.path)) throw new WorkspaceError("ROOT_CHANGED", root.path)
  }
  let canonical: string
  try { canonical = await canonicalTarget(candidate) } catch (error) {
    if (!root && unavailable(error)) return undefined
    throw error
  }
  if (!root && !roots.some((registered) => inside(registered.path, canonical))) return undefined
  assertNotDenied(candidate)
  assertNotDenied(canonical)
  if (!root || !inside(root.path, canonical) || pathKey(canonical) !== pathKey(candidate)) throw new WorkspaceError("OUTSIDE_ROOT", "Linked targets require explicit canonical registration")
  return candidate
}
export function suggestedAlias(directory: string) { return path.basename(directory).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "root" }
export async function browse(raw: string, base: string) {
  const current = await canonicalDirectory(raw, base)
  const entries = (await fs.readdir(current, { withFileTypes: true })).filter((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false
    try { assertNotDenied(path.join(current, entry.name)); return true } catch { return false }
  }).sort((a, b) => a.name.localeCompare(b.name, "en"))
  let parent: string | null = slash(path.dirname(current))
  try { assertNotDenied(parent); if (pathKey(parent) === pathKey(current)) parent = null } catch { parent = null }
  return { current, parent, suggestedAlias: suggestedAlias(current), directories: entries.slice(0, 100).map((entry) => ({ name: entry.name, path: slash(path.join(current, entry.name)) })), truncated: entries.length > 100 }
}
