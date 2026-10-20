import path from "node:path"
import { WorkspaceError } from "../../shared/errors.ts"
import { SEARCH_LIMITS } from "../../shared/limits.ts"
import { slash } from "../filesystem/paths.ts"

export function compileGlob(raw: string): Bun.Glob {
  const value = slash(raw.trim())
  if (
    !value ||
    value.length > SEARCH_LIMITS.patternLength ||
    /[\x00-\x1f\x7f]/.test(value) ||
    path.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split("/").includes("..")
  ) {
    throw new WorkspaceError("INVALID_PATTERN", "Use a relative glob without parent traversal")
  }
  try {
    return new Bun.Glob(value)
  } catch {
    throw new WorkspaceError("INVALID_PATTERN", "Invalid glob pattern")
  }
}

export function globScope(
  pattern: string,
  alias: string | undefined,
): { pattern: string; alias: string | undefined } {
  const prefixed = /^([a-z0-9_-]+):\/(.*)$/s.exec(slash(pattern))
  if (!prefixed) return { pattern, alias }
  if (alias !== undefined && alias !== prefixed[1])
    throw new WorkspaceError("INVALID_PATTERN", "Pattern alias and alias argument disagree")
  return { pattern: prefixed[2] || "**/*", alias: prefixed[1] }
}

export function assertValidRegex(pattern: string): void {
  if (!pattern || pattern.length > SEARCH_LIMITS.patternLength || pattern.includes("\0"))
    throw new WorkspaceError("INVALID_PATTERN", "Regex must be 1-4096 characters, without NUL")
  try {
    new RegExp(pattern, "u")
  } catch {
    throw new WorkspaceError("INVALID_PATTERN", "Invalid JavaScript regular expression")
  }
}
