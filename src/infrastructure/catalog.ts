import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Binding, Workspace, WorkspaceError, type Change, type State } from "../domain.ts"
import { absolute, assertNotDenied, expanded, pathKey, suggestedAlias } from "./paths.ts"

const APPLICATION_ID = 0x57534d32
type Row = { workspace: string | null; sealed: number; directory: string }
type Meta = { catalogID: string; revision: number }

export class Catalog {
  private constructor(private readonly db: Database) {}
  static async open(raw: string, base: string) {
    if (path.extname(raw).toLowerCase() !== ".sqlite") throw new WorkspaceError("INVALID_REGISTRY", "The development catalog must be a new .sqlite file, never the v1 registry")
    const file = absolute(raw, base)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const parent = await fs.realpath(path.dirname(file))
    const canonical = path.join(parent, path.basename(file))
    const info = await fs.lstat(canonical).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined })
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new WorkspaceError("INVALID_REGISTRY", "Catalog must be a regular unlinked file")
    const db = new Database(canonical, { create: true, strict: true })
    try {
      db.exec("PRAGMA busy_timeout=5000")
      db.transaction(() => {
        const app = db.query<{ application_id: number }, []>("PRAGMA application_id").get()!.application_id
        const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()
        if (app !== APPLICATION_ID && (app !== 0 || tables.length || info)) throw new WorkspaceError("INVALID_REGISTRY", "This is not a workspace catalog; nothing was imported or overwritten")
        if (app === APPLICATION_ID) {
          if (db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version !== 1) throw new WorkspaceError("INVALID_REGISTRY", "Unsupported catalog storage version")
          return
        }
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          CREATE TABLE catalog (catalogID TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE bindings (sessionID TEXT PRIMARY KEY, directory TEXT NOT NULL, workspace TEXT, sealed INTEGER NOT NULL CHECK(sealed IN (0,1)));
          CREATE TABLE receipts (requestID TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);`)
        db.query("INSERT INTO catalog VALUES (?, 0)").run(randomUUID())
      }).immediate()
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
      return new Catalog(db)
    } catch (error) { db.close(); throw error }
  }
  close() { this.db.close() }
  private meta(): Meta {
    const meta = this.db.query<Meta, []>("SELECT catalogID, revision FROM catalog").get()
    if (!meta || typeof meta.catalogID !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.catalogID) || !Number.isSafeInteger(meta.revision) || meta.revision < 0) throw new WorkspaceError("INVALID_REGISTRY", "Invalid catalog metadata")
    return meta
  }
  private decode(raw: string, expectedID?: string): Workspace {
    try {
      const workspace = Workspace.parse(JSON.parse(raw))
      if (expectedID && workspace.id !== expectedID) throw new Error("Workspace ID mismatch")
      const aliases = new Set<string>()
      const paths = new Set<string>()
      for (const root of workspace.roots) {
        const value = expanded(root.path)
        if (!path.isAbsolute(value) || value.split("/").includes("..")) throw new Error("Stored root is not absolute")
        assertNotDenied(value)
        if (aliases.has(root.alias) || paths.has(pathKey(value))) throw new Error("Duplicate stored root")
        aliases.add(root.alias); paths.add(pathKey(value))
      }
      return workspace
    } catch { throw new WorkspaceError("INVALID_REGISTRY", "Invalid stored workspace; nothing was overwritten") }
  }
  private row(sessionID: string) { return this.db.query<Row, [string]>("SELECT workspace, sealed, directory FROM bindings WHERE sessionID=?").get(sessionID) }
  private binding(row: Row | null): Binding | null {
    if (row && ((row.sealed !== 0 && row.sealed !== 1) || typeof row.directory !== "string" || !path.isAbsolute(row.directory))) throw new WorkspaceError("INVALID_REGISTRY", "Invalid session binding")
    return row ? Binding.parse({ workspace: row.workspace ? this.decode(row.workspace) : null, sealed: row.sealed === 1, directory: row.directory }) : null
  }
  state(sessionID?: string): State {
    return this.db.transaction(() => ({ ...this.meta(), workspaces: this.db.query<{ id: string; data: string }, []>("SELECT id, data FROM workspaces ORDER BY id").all().map((row) => this.decode(row.data, row.id)).sort((a, b) => a.name.localeCompare(b.name, "en")), binding: sessionID ? this.binding(this.row(sessionID)) : null }))()
  }
  selection(sessionID: string) {
    // Footer refreshes must not enumerate every saved workspace or touch roots.
    return this.db.transaction(() => ({ ...this.meta(), binding: this.binding(this.row(sessionID)) }))()
  }
  capture(sessionID: string, directory: string) {
    return this.db.transaction(() => {
      const row = this.row(sessionID)
      this.meta()
      this.binding(row)
      if (row?.workspace && pathKey(row.directory) !== pathKey(directory)) throw new WorkspaceError("LOCATION_MISMATCH", "This session's workspace belongs to its original Location")
      if (!row && this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM bindings").get()!.count >= 10_000) throw new WorkspaceError("REGISTRY_FULL", "Session catalog maintenance is required; no live bindings were removed")
      this.db.query("INSERT INTO bindings(sessionID,directory,workspace,sealed) VALUES (?,?,NULL,1) ON CONFLICT(sessionID) DO UPDATE SET sealed=1").run(sessionID, directory)
      return this.binding(this.row(sessionID))!
    }).immediate()
  }
  change(input: Change, directory: string, emptySession: boolean, canonicalRoot?: string) {
    this.db.transaction(() => {
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex")
      const receipt = this.db.query<{ fingerprint: string }, [string]>("SELECT fingerprint FROM receipts WHERE requestID=?").get(input.requestID)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkspaceError("REQUEST_CONFLICT", "Request ID was reused for another operation")
        return
      }
      if (input.expectedRevision !== this.meta().revision) throw new WorkspaceError("REVISION_CONFLICT", "Workspace data changed; reopen the menu")
      const action = input.action
      const current = "workspaceID" in action ? this.db.query<{ data: string }, [string]>("SELECT data FROM workspaces WHERE id=?").get(action.workspaceID) : undefined
      const workspace = current ? this.decode(current.data, "workspaceID" in action ? action.workspaceID : undefined) : undefined
      if ("workspaceID" in action && !workspace) throw new WorkspaceError("UNKNOWN_WORKSPACE", "Saved workspace no longer exists")
      if (action.kind === "attach" || action.kind === "detach") {
        if (!input.sessionID) throw new WorkspaceError("SESSION_REQUIRED", "Select an empty session first")
        const old = this.row(input.sessionID)
        if (!emptySession || old?.sealed) throw new WorkspaceError("SESSION_STARTED", "This session has already started. Open the workspace in a new session instead")
        if (old?.workspace && pathKey(old.directory) !== pathKey(directory)) throw new WorkspaceError("LOCATION_MISMATCH", "Session Location changed")
        if (!old && this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM bindings").get()!.count >= 10_000) throw new WorkspaceError("REGISTRY_FULL", "Session catalog maintenance is required")
        this.db.query("INSERT INTO bindings VALUES (?,?,?,0) ON CONFLICT(sessionID) DO UPDATE SET directory=excluded.directory,workspace=excluded.workspace").run(input.sessionID, directory, action.kind === "attach" ? JSON.stringify(workspace!) : null)
      } else if (action.kind === "create") {
        const definitions = this.state().workspaces
        if (definitions.some((item) => item.name === action.name)) throw new WorkspaceError("WORKSPACE_EXISTS", "That workspace name already exists")
        if (definitions.length >= 1000) throw new WorkspaceError("REGISTRY_FULL", "Workspace limit reached")
        const created: Workspace = { id: randomUUID(), name: action.name, revision: 1, roots: [] }
        this.db.query("INSERT INTO workspaces VALUES (?,?)").run(created.id, JSON.stringify(created))
      } else if (action.kind === "remove") this.db.query("DELETE FROM workspaces WHERE id=?").run(workspace!.id)
      else {
        const updated = structuredClone(workspace!)
        let altered = true
        if (action.kind === "addRoot") {
          if (!canonicalRoot) throw new WorkspaceError("INVALID_PATH", "Missing validated root")
          if (!updated.roots.some((root) => pathKey(root.path) === pathKey(canonicalRoot))) {
            if (updated.roots.length >= 20) throw new WorkspaceError("ROOT_LIMIT", "A workspace supports at most 20 folders")
            let alias = action.alias ?? suggestedAlias(canonicalRoot)
            if (action.alias && updated.roots.some((root) => root.alias === alias)) throw new WorkspaceError("ALIAS_EXISTS", "That alias already belongs to another folder")
            for (let suffix = 2; updated.roots.some((root) => root.alias === alias); suffix++) alias = `${suggestedAlias(canonicalRoot)}-${suffix}`
            updated.roots.push({ alias, path: canonicalRoot })
          } else altered = false
        } else {
          if (!updated.roots.some((root) => root.alias === action.alias)) throw new WorkspaceError("UNKNOWN_ROOT", "Folder registration no longer exists")
          updated.roots = updated.roots.filter((root) => root.alias !== action.alias)
        }
        if (altered) {
          updated.revision++
          this.db.query("UPDATE workspaces SET data=? WHERE id=?").run(JSON.stringify(Workspace.parse(updated)), updated.id)
        }
      }
      this.db.query("UPDATE catalog SET revision=revision+1").run()
      this.db.query("INSERT INTO receipts VALUES (?,?)").run(input.requestID, fingerprint)
      this.db.exec("DELETE FROM receipts WHERE rowid NOT IN (SELECT rowid FROM receipts ORDER BY rowid DESC LIMIT 256)")
    }).immediate()
    return this.state(input.sessionID)
  }
}
