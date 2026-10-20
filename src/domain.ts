import { z } from "zod"

const UNAVAILABLE_CODES = ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EBUSY", "EIO", "EROFS"] as const
type UnavailableCode = (typeof UNAVAILABLE_CODES)[number] | `SQLITE_${string}`
export type WorkspaceErrorCode = UnavailableCode
  | "ALIAS_EXISTS" | "BINARY_FILE" | "BINDING_UNAVAILABLE" | "CATALOG_UNAVAILABLE" | "DENIED_PATH" | "IGNORE_TOO_LARGE"
  | "INSTRUCTIONS_REQUIRED" | "INVALID_PATH" | "INVALID_PATTERN" | "INVALID_REGISTRY" | "LOCATION_MISMATCH" | "NOT_DIRECTORY"
  | "NOT_FILE" | "NO_WORKSPACE" | "OUTSIDE_ROOT" | "PATH_CHANGED" | "PLUGIN_DISPOSED" | "REGEX_TIMEOUT" | "REGISTRY_FULL"
  | "REQUEST_CONFLICT" | "REVISION_CONFLICT" | "ROOT_CHANGED" | "ROOT_LIMIT" | "SEARCH_LIMIT" | "SESSION_REQUIRED"
  | "SESSION_STARTED" | "UNKNOWN_ALIAS" | "UNKNOWN_ROOT" | "UNKNOWN_WORKSPACE" | "USE_WORKSPACE_SEARCH" | "WORKSPACE_EXISTS"

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) { super(`${code}: ${message}`) }
}
// Thrown values are unknown; read a filesystem/SQLite/workspace code without assuming their shape.
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined
}
export function isUnavailableCode(code: string | undefined): code is UnavailableCode {
  return code !== undefined && (UNAVAILABLE_CODES.some((known) => known === code) || code.startsWith("SQLITE_"))
}
export function unreachable(value: never): never { throw new Error(`Unhandled value: ${JSON.stringify(value)}`) }
export const Name = z.string().trim().min(1).max(100).refine((name) => !/[\x00-\x1f\x7f]/.test(name) && !["__proto__", "prototype", "constructor"].includes(name.toLowerCase()), "Use a printable, non-reserved name")
export const Alias = z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/)
export const SessionID = z.string().regex(/^ses_[a-zA-Z0-9_-]{1,180}$/)
// The brand applies to parsed output only, so RPC callers still send plain strings.
export const WorkspaceID = z.uuid().brand<"WorkspaceID">()
export type WorkspaceID = z.infer<typeof WorkspaceID>
export const Root = z.object({ alias: Alias, path: z.string().min(1) }).strict()
export const Workspace = z.object({ id: WorkspaceID, name: Name, revision: z.number().int().positive(), roots: z.array(Root).max(20) }).strict()
export type Workspace = z.infer<typeof Workspace>
export const Binding = z.object({ workspace: Workspace.nullable(), sealed: z.boolean(), directory: z.string() }).strict()
export type Binding = z.infer<typeof Binding>
export const State = z.object({ catalogID: z.uuid().nullable(), revision: z.number().int().nonnegative(), workspaces: z.array(Workspace), binding: Binding.nullable(), canAttach: z.boolean() }).strict()
export type State = z.infer<typeof State>
export const Selection = z.object({
  catalogID: z.uuid().nullable(), revision: z.number().int().nonnegative(),
  workspace: z.object({ id: WorkspaceID, name: Name, revision: z.number().int().positive(), rootCount: z.number().int().min(0).max(20) }).strict().nullable(),
  sealed: z.boolean(), instructions: z.enum(["not-loaded", "ready", "blocked"]),
}).strict()
export type Selection = z.infer<typeof Selection>
export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name: Name }).strict(),
  z.object({ kind: z.literal("addRoot"), workspaceID: WorkspaceID, path: z.string().min(1), alias: Alias.optional() }).strict(),
  z.object({ kind: z.literal("removeRoot"), workspaceID: WorkspaceID, alias: Alias }).strict(),
  z.object({ kind: z.literal("remove"), workspaceID: WorkspaceID }).strict(),
  z.object({ kind: z.literal("attach"), workspaceID: WorkspaceID }).strict(),
  z.object({ kind: z.literal("detach") }).strict(),
])
export type Action = z.infer<typeof Action>
export const Change = z.object({ requestID: z.uuid(), expectedRevision: z.number().int().nonnegative(), sessionID: SessionID.optional(), action: Action }).strict()
export type Change = z.infer<typeof Change>
