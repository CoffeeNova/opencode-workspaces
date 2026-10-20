import * as fs from "node:fs/promises"
import path from "node:path"
import { BROWSE_LIMITS } from "../../shared/limits.ts"
import type { BrowsePage } from "../../shared/schemas.ts"
import { pathKey, slash } from "./paths.ts"
import { assertNotDenied, canonicalDirectory, suggestedAlias } from "./policy.ts"

function isAllowed(value: string) {
  try {
    assertNotDenied(value)
    return true
  } catch {
    return false
  }
}

function parentDirectory(current: string) {
  const parent = slash(path.dirname(current))
  if (!isAllowed(parent)) return null
  if (pathKey(parent) === pathKey(current)) return null
  return parent
}

export async function browseDirectory(raw: string, base: string): Promise<BrowsePage> {
  const current = await canonicalDirectory(raw, base)
  const entries = (await fs.readdir(current, { withFileTypes: true }))
    .filter((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false
      return isAllowed(path.join(current, entry.name))
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
  return {
    current,
    parent: parentDirectory(current),
    suggestedAlias: suggestedAlias(current),
    directories: entries
      .slice(0, BROWSE_LIMITS.directories)
      .map((entry) => ({ name: entry.name, path: slash(path.join(current, entry.name)) })),
    truncated: entries.length > BROWSE_LIMITS.directories,
  }
}
