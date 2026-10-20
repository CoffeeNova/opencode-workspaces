import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { WorkspaceError, unreachable } from "../../shared/errors.ts"
import { CATALOG_LIMITS } from "../../shared/limits.ts"
import { Workspace, WorkspaceID, type Action } from "../../shared/schemas.ts"
import { pathKey } from "../filesystem/paths.ts"
import { suggestedAlias } from "../filesystem/policy.ts"
import { decodeWorkspace, readBindingRow } from "./codec.ts"

export type ActionContext = {
  db: Database
  sessionID: string | undefined
  directory: string
  emptySession: boolean
  canonicalRoot: string | undefined
  workspaces(): Workspace[]
}

type Kind<K extends Action["kind"]> = Extract<Action, { kind: K }>

function savedWorkspace(db: Database, id: WorkspaceID): Workspace {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM workspaces WHERE id=?").get(id)
  if (!row) throw new WorkspaceError("UNKNOWN_WORKSPACE", "Saved workspace no longer exists")
  return decodeWorkspace(row.data, id)
}

function saveRevision(db: Database, updated: Workspace) {
  const next = Workspace.parse({ ...updated, revision: updated.revision + 1 })
  db.query("UPDATE workspaces SET data=? WHERE id=?").run(JSON.stringify(next), next.id)
}

function applyBindingAction(ctx: ActionContext, action: Kind<"attach"> | Kind<"detach">) {
  const workspace = action.kind === "attach" ? savedWorkspace(ctx.db, action.workspaceID) : null
  if (!ctx.sessionID) throw new WorkspaceError("SESSION_REQUIRED", "Select an empty session first")
  const old = readBindingRow(ctx.db, ctx.sessionID)
  if (!ctx.emptySession || old?.sealed)
    throw new WorkspaceError(
      "SESSION_STARTED",
      "This session has started or cannot be confirmed empty. Open the workspace in a new session instead",
    )
  if (old?.workspace && pathKey(old.directory) !== pathKey(ctx.directory))
    throw new WorkspaceError("LOCATION_MISMATCH", "Session Location changed")
  if (
    !old &&
    ctx.db.query<{ count: number }, []>("SELECT count(*) AS count FROM bindings").get()!.count >=
      CATALOG_LIMITS.bindings
  )
    throw new WorkspaceError("REGISTRY_FULL", "Session catalog maintenance is required")
  ctx.db
    .query(
      "INSERT INTO bindings VALUES (?,?,?,0) ON CONFLICT(sessionID) DO UPDATE SET directory=excluded.directory,workspace=excluded.workspace",
    )
    .run(ctx.sessionID, ctx.directory, workspace ? JSON.stringify(workspace) : null)
}

function applyCreate(ctx: ActionContext, action: Kind<"create">) {
  const definitions = ctx.workspaces()
  if (definitions.some((item) => item.name === action.name))
    throw new WorkspaceError("WORKSPACE_EXISTS", "That workspace name already exists")
  if (definitions.length >= CATALOG_LIMITS.workspaces)
    throw new WorkspaceError("REGISTRY_FULL", "Workspace limit reached")
  const created: Workspace = {
    id: WorkspaceID.parse(randomUUID()),
    name: action.name,
    revision: 1,
    roots: [],
  }
  ctx.db.query("INSERT INTO workspaces VALUES (?,?)").run(created.id, JSON.stringify(created))
}

function applyRemove(ctx: ActionContext, action: Kind<"remove">) {
  ctx.db
    .query("DELETE FROM workspaces WHERE id=?")
    .run(savedWorkspace(ctx.db, action.workspaceID).id)
}

function applyAddRoot(ctx: ActionContext, action: Kind<"addRoot">) {
  const updated = savedWorkspace(ctx.db, action.workspaceID)
  const canonicalRoot = ctx.canonicalRoot
  if (!canonicalRoot) throw new WorkspaceError("INVALID_PATH", "Missing validated root")
  // An already registered root is a no-op for the workspace, but the caller still bumps the
  // catalog revision and records the receipt.
  if (updated.roots.some((root) => pathKey(root.path) === pathKey(canonicalRoot))) return
  if (updated.roots.length >= CATALOG_LIMITS.roots)
    throw new WorkspaceError("ROOT_LIMIT", "A workspace supports at most 20 folders")
  let alias = action.alias ?? suggestedAlias(canonicalRoot)
  if (action.alias && updated.roots.some((root) => root.alias === alias))
    throw new WorkspaceError("ALIAS_EXISTS", "That alias already belongs to another folder")
  for (let suffix = 2; updated.roots.some((root) => root.alias === alias); suffix++)
    alias = `${suggestedAlias(canonicalRoot)}-${suffix}`
  updated.roots.push({ alias, path: canonicalRoot })
  saveRevision(ctx.db, updated)
}

function applyRemoveRoot(ctx: ActionContext, action: Kind<"removeRoot">) {
  const updated = savedWorkspace(ctx.db, action.workspaceID)
  if (!updated.roots.some((root) => root.alias === action.alias))
    throw new WorkspaceError("UNKNOWN_ROOT", "Folder registration no longer exists")
  updated.roots = updated.roots.filter((root) => root.alias !== action.alias)
  saveRevision(ctx.db, updated)
}

export function applyAction(ctx: ActionContext, action: Action) {
  switch (action.kind) {
    case "attach":
    case "detach":
      return applyBindingAction(ctx, action)
    case "create":
      return applyCreate(ctx, action)
    case "remove":
      return applyRemove(ctx, action)
    case "addRoot":
      return applyAddRoot(ctx, action)
    case "removeRoot":
      return applyRemoveRoot(ctx, action)
    default:
      unreachable(action)
  }
}
