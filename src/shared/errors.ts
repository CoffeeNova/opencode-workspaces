export const UNAVAILABLE_ERROR_CODES = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "EBUSY",
  "EIO",
  "EROFS",
] as const

export type UnavailableCode = (typeof UNAVAILABLE_ERROR_CODES)[number] | `SQLITE_${string}`

export type WorkspaceErrorCode =
  | UnavailableCode
  | "ALIAS_EXISTS"
  | "BINARY_FILE"
  | "BINDING_UNAVAILABLE"
  | "CATALOG_UNAVAILABLE"
  | "DENIED_PATH"
  | "IGNORE_TOO_LARGE"
  | "INSTRUCTIONS_REQUIRED"
  | "INVALID_PATH"
  | "INVALID_PATTERN"
  | "INVALID_REGISTRY"
  | "LOCATION_MISMATCH"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "NO_WORKSPACE"
  | "OUTSIDE_ROOT"
  | "PATH_CHANGED"
  | "PLUGIN_DISPOSED"
  | "REGEX_TIMEOUT"
  | "REGISTRY_FULL"
  | "REQUEST_CONFLICT"
  | "REVISION_CONFLICT"
  | "ROOT_CHANGED"
  | "ROOT_LIMIT"
  | "SEARCH_LIMIT"
  | "SESSION_REQUIRED"
  | "SESSION_STARTED"
  | "UNKNOWN_ALIAS"
  | "UNKNOWN_ROOT"
  | "UNKNOWN_WORKSPACE"
  | "USE_WORKSPACE_SEARCH"
  | "WORKSPACE_EXISTS"

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

// Thrown values are unknown; read a filesystem/SQLite/workspace code without assuming their shape.
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined
}

export function isUnavailableCode(code: string | undefined): code is UnavailableCode {
  return (
    code !== undefined &&
    (UNAVAILABLE_ERROR_CODES.some((known) => known === code) || code.startsWith("SQLITE_"))
  )
}

export function errorText(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error)
}

export function unreachable(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`)
}
