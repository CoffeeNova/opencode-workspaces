import * as fs from "node:fs/promises"
import path from "node:path"
import { isNotFound } from "../../shared/errors.ts"
import { isInsideResolved, resolvedKey } from "../filesystem/paths.ts"
import { InstructionError, type InstructionRoot } from "./types.ts"

// Maps a native target path to every directory whose AGENTS.md applies to it.
export async function instructionDirectories(
  roots: readonly InstructionRoot[],
  target: string,
): Promise<string[]> {
  const lexical = absoluteTarget(target)
  const owners = owningRoots(roots, lexical, target)
  await assertRootsNotRetargeted(owners)
  await assertNotLinked(lexical, target)
  const directory = await containingDirectory(lexical)
  return ancestorDirectories(owners, directory)
}

function absoluteTarget(target: string): string {
  if (!path.isAbsolute(target))
    throw new InstructionError("UNSUPPORTED_TARGET", "Use absolute native paths")
  return path.resolve(target)
}

function owningRoots(
  roots: readonly InstructionRoot[],
  lexical: string,
  target: string,
): InstructionRoot[] {
  const owners = roots
    .filter((root) => isInsideResolved(root.path, lexical))
    .sort((a, b) => b.path.length - a.path.length)
  if (!owners.length)
    throw new InstructionError("UNSUPPORTED_TARGET", `Outside the selected roots: ${target}`)
  return owners
}

async function assertRootsNotRetargeted(owners: readonly InstructionRoot[]): Promise<void> {
  for (const root of owners) {
    if (resolvedKey(await fs.realpath(root.path)) !== resolvedKey(root.path))
      throw new InstructionError("UNSUPPORTED_TARGET", `Root retargeted: ${root.path}`)
  }
}

// Resolve even a new file through its nearest existing parent. This proof
// rejects linked targets; arbitrary concurrent filesystem retargeting is not
// made atomic by this check.
async function assertNotLinked(lexical: string, target: string): Promise<void> {
  let existing = lexical
  const suffix: string[] = []
  while (true) {
    try {
      const real = path.join(await fs.realpath(existing), ...suffix)
      if (resolvedKey(path.resolve(real)) !== resolvedKey(path.resolve(lexical)))
        throw new InstructionError("UNSUPPORTED_TARGET", `Linked target: ${target}`)
      return
    } catch (error) {
      if (!isNotFound(error)) throw error
      suffix.unshift(path.basename(existing))
      existing = path.dirname(existing)
    }
  }
}

async function containingDirectory(lexical: string): Promise<string> {
  const stat = await fs.stat(lexical).catch((error: unknown) => {
    if (!isNotFound(error)) throw error
    return undefined
  })
  return stat?.isDirectory() ? lexical : path.dirname(lexical)
}

// Overlap keeps all applicable ancestor scopes but deduplicates physical
// sources. Most-specific root ownership does not erase registered ancestors.
function ancestorDirectories(owners: readonly InstructionRoot[], directory: string): string[] {
  const directories = new Set<string>()
  for (const root of owners) {
    let current = directory
    while (isInsideResolved(root.path, current)) {
      directories.add(current)
      if (resolvedKey(current) === resolvedKey(root.path)) break
      current = path.dirname(current)
    }
  }
  return [...directories]
}
