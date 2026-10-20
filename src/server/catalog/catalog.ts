import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { WorkspaceError } from "../../shared/errors.ts"
import { CATALOG_LIMITS } from "../../shared/limits.ts"
import { type Change } from "../../shared/schemas.ts"
import { pathKey } from "../filesystem/paths.ts"
import { applyAction, type ActionContext } from "./actions.ts"
import { decodeBinding, decodeWorkspace, readBindingRow, readMeta } from "./codec.ts"
import {
  assertReadableCatalog,
  configureConnection,
  enableDurableWrites,
  initializeCatalog,
  locateCatalog,
  writableCatalogFormat,
} from "./storage.ts"

export class Catalog {
  private constructor(private readonly db: Database) {}

  static async defaultPath() {
    return path.join(homedir(), ".config", "opencode", "workspace-manager", "workspaces-v2.sqlite")
  }

  static async existing(raw: string, base: string) {
    const target = await locateCatalog(raw, base, false)
    if (!target) return
    const db = new Database(target.file, { readonly: true, strict: true })
    try {
      configureConnection(db)
      assertReadableCatalog(db)
      const catalog = new Catalog(db)
      readMeta(db)
      return catalog
    } catch (error) {
      db.close()
      throw error
    }
  }

  static async open(raw: string, base: string, create = true) {
    const target = await locateCatalog(raw, base, create)
    if (!target)
      throw new WorkspaceError(
        "CATALOG_UNAVAILABLE",
        "The workspace catalog is missing; restore it before using an existing workspace session",
      )
    const db = new Database(target.file, { create, strict: true })
    try {
      configureConnection(db)
      db.transaction(() => {
        const format = writableCatalogFormat(db, target.exists)
        if (format === "empty") initializeCatalog(db)
      }).immediate()
      enableDurableWrites(db)
      return new Catalog(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  close() {
    this.db.close()
  }

  state(sessionID?: string) {
    return this.db.transaction(() => ({
      ...readMeta(this.db),
      workspaces: this.db
        .query<{ id: string; data: string }, []>("SELECT id, data FROM workspaces ORDER BY id")
        .all()
        .map((row) => decodeWorkspace(row.data, row.id))
        .sort((a, b) => a.name.localeCompare(b.name, "en")),
      binding: sessionID ? decodeBinding(readBindingRow(this.db, sessionID)) : null,
    }))()
  }

  selection(sessionID: string) {
    // Footer refreshes must not enumerate every saved workspace or touch roots.
    return this.db.transaction(() => ({
      ...readMeta(this.db),
      binding: decodeBinding(readBindingRow(this.db, sessionID)),
    }))()
  }

  capture(sessionID: string, directory: string) {
    return this.db
      .transaction(() => {
        const row = readBindingRow(this.db, sessionID)
        readMeta(this.db)
        const binding = decodeBinding(row)
        if (!binding?.workspace) return null
        if (pathKey(binding.directory) !== pathKey(directory))
          throw new WorkspaceError(
            "LOCATION_MISMATCH",
            "This session's workspace belongs to its original Location",
          )
        this.db.query("UPDATE bindings SET sealed=1 WHERE sessionID=?").run(sessionID)
        return { ...binding, sealed: true }
      })
      .immediate()
  }

  change(input: Change, directory: string, emptySession: boolean, canonicalRoot?: string) {
    this.db
      .transaction(() => {
        const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex")
        const receipt = this.db
          .query<{ fingerprint: string }, [string]>(
            "SELECT fingerprint FROM receipts WHERE requestID=?",
          )
          .get(input.requestID)
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw new WorkspaceError(
              "REQUEST_CONFLICT",
              "Request ID was reused for another operation",
            )
          return
        }
        if (input.expectedRevision !== readMeta(this.db).revision)
          throw new WorkspaceError("REVISION_CONFLICT", "Workspace data changed; reopen the menu")
        const context: ActionContext = {
          db: this.db,
          sessionID: input.sessionID,
          directory,
          emptySession,
          canonicalRoot,
          workspaces: () => this.state().workspaces,
        }
        applyAction(context, input.action)
        this.db.query("UPDATE catalog SET revision=revision+1").run()
        this.db.query("INSERT INTO receipts VALUES (?,?)").run(input.requestID, fingerprint)
        this.db.exec(
          `DELETE FROM receipts WHERE rowid NOT IN (SELECT rowid FROM receipts ORDER BY rowid DESC LIMIT ${CATALOG_LIMITS.receipts})`,
        )
      })
      .immediate()
    return this.state(input.sessionID)
  }
}
