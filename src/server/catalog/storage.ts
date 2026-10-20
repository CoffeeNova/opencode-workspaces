import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { errorCode, WorkspaceError } from "../../shared/errors.ts"
import { CATALOG_LIMITS } from "../../shared/limits.ts"
import { resolvePath } from "../filesystem/paths.ts"

export const APPLICATION_ID = 0x57534d32
export const STORAGE_VERSION = 2
export const SCHEMA_SQL = `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${STORAGE_VERSION};
          CREATE TABLE catalog (catalogID TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE bindings (sessionID TEXT PRIMARY KEY, directory TEXT NOT NULL, workspace TEXT, sealed INTEGER NOT NULL CHECK(sealed IN (0,1)));
          CREATE TABLE receipts (requestID TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);`

export type CatalogTarget = { file: string; exists: boolean }
export type CatalogFormat = "ready" | "empty"

export async function locateCatalog(
  raw: string,
  base: string,
  create: boolean,
): Promise<CatalogTarget | undefined> {
  if (path.extname(raw).toLowerCase() !== ".sqlite")
    throw new WorkspaceError("INVALID_REGISTRY", "Workspace catalogs require a .sqlite path")
  const file = resolvePath(raw, base)
  if (create) await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const info = await fs.lstat(file).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error
    return undefined
  })
  if (!info && !create) return
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new WorkspaceError("INVALID_REGISTRY", "Catalog must be a regular unlinked file")
  return {
    file: path.join(await fs.realpath(path.dirname(file)), path.basename(file)),
    exists: !!info,
  }
}

export function configureConnection(db: Database) {
  db.exec(`PRAGMA busy_timeout=${CATALOG_LIMITS.busyTimeoutMs}`)
}

export function enableDurableWrites(db: Database) {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
}

function hasTables(db: Database) {
  return (
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()
      .length > 0
  )
}

function assertSupportedVersion(db: Database) {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  if (version !== STORAGE_VERSION)
    throw new WorkspaceError(
      "INVALID_REGISTRY",
      `Unsupported catalog storage version ${version}; expected ${STORAGE_VERSION}`,
    )
}

// Read-only opens pass allowEmpty=false: anything but a v2 catalog is rejected.
// Writable opens pass allowEmpty=true: a brand-new, table-less file (not yet on disk
// before this open) is reported as "empty" so the caller can initialize it.
export function assertCatalogFormat(
  db: Database,
  options: { allowEmpty: boolean; exists: boolean },
): CatalogFormat {
  const app = db.query<{ application_id: number }, []>("PRAGMA application_id").get()!
    .application_id
  if (app === APPLICATION_ID) {
    assertSupportedVersion(db)
    return "ready"
  }
  if (options.allowEmpty && app === 0 && !hasTables(db) && !options.exists) return "empty"
  throw new WorkspaceError(
    "INVALID_REGISTRY",
    "This is not a workspace catalog; nothing was overwritten",
  )
}

export function initializeCatalog(db: Database) {
  db.exec(SCHEMA_SQL)
  db.query("INSERT INTO catalog VALUES (?, 0)").run(randomUUID())
}
