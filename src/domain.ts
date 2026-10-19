import { z } from "zod"

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}
export const Name = z.string().trim().min(1).max(100).refine((name) => !/[\x00-\x1f\x7f]/.test(name) && !["__proto__", "prototype", "constructor"].includes(name.toLowerCase()), "Use a printable, non-reserved name")
export const Alias = z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/)
export const SessionID = z.string().regex(/^ses_[a-zA-Z0-9_-]{1,180}$/)
export const Root = z.object({ alias: Alias, path: z.string().min(1) }).strict()
export const Workspace = z.object({ id: z.uuid(), name: Name, revision: z.number().int().positive(), roots: z.array(Root).max(20) }).strict()
export type Workspace = z.infer<typeof Workspace>
export const Binding = z.object({ workspace: Workspace.nullable(), sealed: z.boolean(), directory: z.string() }).strict()
export type Binding = z.infer<typeof Binding>
export const State = z.object({ catalogID: z.uuid(), revision: z.number().int().nonnegative(), workspaces: z.array(Workspace), binding: Binding.nullable() }).strict()
export type State = z.infer<typeof State>
export const LegacyPreview = z.object({
  sourcePath: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), active: z.string().nullable(),
  workspaces: z.array(z.object({ name: Name, rootCount: z.number().int().min(0).max(20) }).strict()).max(1000),
}).strict()
export const LegacyImportResult = z.object({
  sourcePath: z.string(), backupPath: z.string(),
  imported: z.array(z.object({ id: z.uuid(), name: Name }).strict()).max(1000),
  suggestedWorkspaceID: z.uuid().nullable(),
}).strict()
export type LegacyImportResult = z.infer<typeof LegacyImportResult>
export const Selection = z.object({
  catalogID: z.uuid(), revision: z.number().int().nonnegative(),
  workspace: z.object({ id: z.uuid(), name: Name, revision: z.number().int().positive(), rootCount: z.number().int().min(0).max(20) }).strict().nullable(),
  sealed: z.boolean(), instructions: z.enum(["not-loaded", "ready", "blocked"]),
}).strict()
export type Selection = z.infer<typeof Selection>
export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name: Name }).strict(),
  z.object({ kind: z.literal("addRoot"), workspaceID: z.uuid(), path: z.string().min(1), alias: Alias.optional() }).strict(),
  z.object({ kind: z.literal("removeRoot"), workspaceID: z.uuid(), alias: Alias }).strict(),
  z.object({ kind: z.literal("remove"), workspaceID: z.uuid() }).strict(),
  z.object({ kind: z.literal("attach"), workspaceID: z.uuid() }).strict(),
  z.object({ kind: z.literal("detach") }).strict(),
])
export type Action = z.infer<typeof Action>
export const Change = z.object({ requestID: z.uuid(), expectedRevision: z.number().int().nonnegative(), sessionID: SessionID.optional(), action: Action }).strict()
export type Change = z.infer<typeof Change>
