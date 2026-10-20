import { homedir } from "node:os"
import path from "node:path"
import { WorkspaceError } from "../../shared/errors.ts"

const isWindows = () => process.platform === "win32"
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export const slash = (value: string) => value.replaceAll("\\", "/")

// Lexical key: forward slashes, no trailing slash, never resolved against the cwd.
export const pathKey = (value: string) =>
  isWindows() ? slash(value).replace(/\/$/, "").toLowerCase() : slash(value).replace(/\/$/, "")

function isRelativeInside(relative: string) {
  if (relative === "") return true
  if (path.isAbsolute(relative)) return false
  return relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

// Lexical containment: both sides are compared as given, only lower-cased on Windows.
export function isInside(root: string, candidate: string) {
  const relative = path.relative(
    isWindows() ? root.toLowerCase() : root,
    isWindows() ? candidate.toLowerCase() : candidate,
  )
  return isRelativeInside(relative)
}

// Resolved key: path.resolve against the cwd with platform separators. Instruction
// delivery orders and deduplicates its sources by this key, so it stays distinct from pathKey.
export const resolvedKey = (value: string) =>
  isWindows() ? path.resolve(value).toLowerCase() : path.resolve(value)

// Resolved containment: both sides go through resolvedKey first.
export function isInsideResolved(root: string, target: string) {
  const relative = path.relative(resolvedKey(root), resolvedKey(target))
  return isRelativeInside(relative)
}

function isQuoted(value: string) {
  if (value.startsWith('"') && value.endsWith('"')) return true
  return value.startsWith("'") && value.endsWith("'")
}

function isDevicePath(value: string) {
  if (!value) return true
  if (/[\x00-\x1f\x7f]/.test(value)) return true
  if (/^\/\/[?.]\//.test(value)) return true
  return value.startsWith("/??/")
}

function isReservedWindowsPart(part: string) {
  if (part === "." || part === "..") return false
  return /[. ]$/.test(part) || WINDOWS_DEVICE_NAME.test(part)
}

function assertWindowsPath(value: string) {
  if (/^[a-z]:($|[^/])/i.test(value) || (value.startsWith("/") && !value.startsWith("//")))
    throw new WorkspaceError("INVALID_PATH", "Use an absolute drive path")
  const suffix = value.replace(/^[a-z]:/i, "")
  if (/[<>:"|?*]/.test(suffix) || suffix.split("/").some(isReservedWindowsPart))
    throw new WorkspaceError(
      "INVALID_PATH",
      "Reserved Windows path component or alternate data stream",
    )
}

function assertPosixPath(value: string) {
  if (/^[a-z]:/i.test(value) || value.startsWith("//"))
    throw new WorkspaceError("INVALID_PATH", "Windows paths cannot be resolved on this server")
}

export function expandPath(raw: string) {
  let value = raw.trim()
  if (isQuoted(value)) value = value.slice(1, -1)
  value = slash(value)
    .replace(/^~(?=\/|$)/, slash(homedir()))
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, slash(homedir()))
  if (isDevicePath(value))
    throw new WorkspaceError("INVALID_PATH", "Empty, control-character, or device path")
  if (isWindows()) assertWindowsPath(value)
  else assertPosixPath(value)
  return value
}

export function resolvePath(raw: string, base: string) {
  return slash(path.resolve(base, expandPath(raw)))
}
