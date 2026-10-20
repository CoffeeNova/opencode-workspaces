import type { Database } from "bun:sqlite"
import path from "node:path"
import { WorkspaceError } from "../../shared/errors.ts"
import { Binding, Workspace } from "../../shared/schemas.ts"
import { expandPath, pathKey } from "../filesystem/paths.ts"
import { assertNotDenied } from "../filesystem/policy.ts"

export type BindingRow = { workspace: string | null; sealed: number; directory: string }
export type CatalogMeta = { catalogID: string; revision: number }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function readMeta(db: Database): CatalogMeta {
  const meta = db.query<CatalogMeta, []>("SELECT catalogID, revision FROM catalog").get()
  if (
    !meta ||
    typeof meta.catalogID !== "string" ||
    !UUID_V4.test(meta.catalogID) ||
    !Number.isSafeInteger(meta.revision) ||
    meta.revision < 0
  )
    throw new WorkspaceError("INVALID_REGISTRY", "Invalid catalog metadata")
  return meta
}

export function readBindingRow(db: Database, sessionID: string) {
  return db
    .query<BindingRow, [string]>(
      "SELECT workspace, sealed, directory FROM bindings WHERE sessionID=?",
    )
    .get(sessionID)
}

function assertStoredRoots(workspace: Workspace) {
  const aliases = new Set<string>()
  const paths = new Set<string>()
  for (const root of workspace.roots) {
    const value = expandPath(root.path)
    if (!path.isAbsolute(value) || value.split("/").includes(".."))
      throw new Error("Stored root is not absolute")
    assertNotDenied(value)
    if (aliases.has(root.alias) || paths.has(pathKey(value)))
      throw new Error("Duplicate stored root")
    aliases.add(root.alias)
    paths.add(pathKey(value))
  }
}

export function decodeWorkspace(raw: string, expectedID?: string): Workspace {
  try {
    const workspace = Workspace.parse(JSON.parse(raw))
    if (expectedID && workspace.id !== expectedID) throw new Error("Workspace ID mismatch")
    assertStoredRoots(workspace)
    return workspace
  } catch {
    throw new WorkspaceError(
      "INVALID_REGISTRY",
      "Invalid stored workspace; nothing was overwritten",
    )
  }
}

export function decodeBinding(row: BindingRow | null): Binding | null {
  if (
    row &&
    ((row.sealed !== 0 && row.sealed !== 1) ||
      typeof row.directory !== "string" ||
      !path.isAbsolute(row.directory))
  )
    throw new WorkspaceError("INVALID_REGISTRY", "Invalid session binding")
  if (!row) return null
  return Binding.parse({
    workspace: row.workspace ? decodeWorkspace(row.workspace) : null,
    sealed: row.sealed === 1,
    directory: row.directory,
  })
}
