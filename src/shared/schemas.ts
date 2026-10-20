import { z } from "zod"
import { CATALOG_LIMITS } from "./limits.ts"

const RESERVED_NAMES = ["__proto__", "prototype", "constructor"]

function isPrintableName(name: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(name) && !RESERVED_NAMES.includes(name.toLowerCase())
}

export const Name = z
  .string()
  .trim()
  .min(1)
  .max(CATALOG_LIMITS.nameLength)
  .refine(isPrintableName, "Use a printable, non-reserved name")

export const Alias = z
  .string()
  .min(1)
  .max(CATALOG_LIMITS.aliasLength)
  .regex(/^[a-z0-9_-]+$/)

export const SessionID = z.string().regex(/^ses_[a-zA-Z0-9_-]{1,180}$/)

// The brand applies to parsed output only, so RPC callers still send plain strings.
export const WorkspaceID = z.uuid().brand<"WorkspaceID">()
export type WorkspaceID = z.infer<typeof WorkspaceID>

export const Root = z
  .object({
    alias: Alias,
    path: z.string().min(1),
  })
  .strict()

export const Workspace = z
  .object({
    id: WorkspaceID,
    name: Name,
    revision: z.number().int().positive(),
    roots: z.array(Root).max(CATALOG_LIMITS.roots),
  })
  .strict()
export type Workspace = z.infer<typeof Workspace>

export const Binding = z
  .object({
    workspace: Workspace.nullable(),
    sealed: z.boolean(),
    directory: z.string(),
  })
  .strict()
export type Binding = z.infer<typeof Binding>

export const State = z
  .object({
    catalogID: z.uuid().nullable(),
    revision: z.number().int().nonnegative(),
    workspaces: z.array(Workspace),
    binding: Binding.nullable(),
    canAttach: z.boolean(),
  })
  .strict()
export type State = z.infer<typeof State>

export const SelectionWorkspace = z
  .object({
    id: WorkspaceID,
    name: Name,
    revision: z.number().int().positive(),
    rootCount: z.number().int().min(0).max(CATALOG_LIMITS.roots),
  })
  .strict()

export const Selection = z
  .object({
    catalogID: z.uuid().nullable(),
    revision: z.number().int().nonnegative(),
    workspace: SelectionWorkspace.nullable(),
    sealed: z.boolean(),
    instructions: z.enum(["not-loaded", "ready", "blocked"]),
  })
  .strict()
export type Selection = z.infer<typeof Selection>

export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), name: Name }).strict(),
  z
    .object({
      kind: z.literal("addRoot"),
      workspaceID: WorkspaceID,
      path: z.string().min(1),
      alias: Alias.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("removeRoot"), workspaceID: WorkspaceID, alias: Alias }).strict(),
  z.object({ kind: z.literal("remove"), workspaceID: WorkspaceID }).strict(),
  z.object({ kind: z.literal("attach"), workspaceID: WorkspaceID }).strict(),
  z.object({ kind: z.literal("detach") }).strict(),
])
export type Action = z.infer<typeof Action>

export const Change = z
  .object({
    requestID: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    sessionID: SessionID.optional(),
    action: Action,
  })
  .strict()
export type Change = z.infer<typeof Change>

export const BrowsePage = z
  .object({
    current: z.string(),
    parent: z.string().nullable(),
    suggestedAlias: z.string(),
    directories: z.array(z.object({ name: z.string(), path: z.string() })),
    truncated: z.boolean(),
  })
  .strict()
export type BrowsePage = z.infer<typeof BrowsePage>

export const ChangedEvent = z
  .object({
    catalogID: z.uuid(),
    revision: z.number().int().nonnegative(),
    sessionID: SessionID.optional(),
  })
  .strict()
