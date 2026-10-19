import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Catalog } from "../src/infrastructure/catalog.ts"
import { backupLegacy, importLegacy, previewLegacy } from "../src/infrastructure/legacy-import.ts"
import { slash } from "../src/infrastructure/paths.ts"
import { registryLock } from "../src/infrastructure/registry-lock.ts"

let base: string
let catalog: Catalog
beforeEach(async () => {
  await fs.mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "opencode/catalog-import-")))
  catalog = await Catalog.open(path.join(base, "catalog.sqlite"), base)
})
afterEach(async () => { catalog.close(); await fs.rm(base, { recursive: true, force: true }) })
const imported = () => ({
  sourcePath: slash(path.join(base, "workspaces.json")), fingerprint: "a".repeat(64), backupPath: slash(path.join(base, "backup.json")), active: "legacy",
  workspaces: [{ name: "legacy", roots: [{ alias: "docs", path: slash(path.join(base, "missing docs")) }] }],
})

test("imports stable definitions without binding sessions and replays after restart", async () => {
  catalog.capture("ses_existing", base)
  const result = catalog.importLegacy(imported(), 0)
  expect(result.imported).toHaveLength(1)
  expect(result.suggestedWorkspaceID).toBe(result.imported[0]!.id)
  expect(catalog.state().workspaces[0]!.roots).toEqual(imported().workspaces[0]!.roots)
  expect(catalog.selection("ses_existing").binding?.workspace).toBeNull()
  expect(catalog.selection("ses_new").binding).toBeNull()
  catalog.close()
  catalog = await Catalog.open(path.join(base, "catalog.sqlite"), base)
  expect(catalog.importLegacy(imported(), 0)).toEqual(result)
  expect(catalog.state().revision).toBe(1)
  expect(catalog.state().workspaces).toHaveLength(1)
  expect(() => catalog.importLegacy({ ...imported(), fingerprint: "b".repeat(64) }, 1)).toThrow("IMPORT_CHANGED")
})

test("name conflicts and invalid definitions leave no partial imports or receipt", () => {
  const duplicate = { ...imported(), workspaces: [...imported().workspaces, ...imported().workspaces] }
  expect(() => catalog.importLegacy(duplicate, 0)).toThrow("WORKSPACE_EXISTS")
  expect(catalog.state().workspaces).toEqual([])
  expect(catalog.imported(duplicate.sourcePath, duplicate.fingerprint)).toBeUndefined()
  const invalid = { ...imported(), workspaces: [...imported().workspaces, { name: "invalid", roots: [{ alias: "bad", path: "relative" }] }] }
  expect(() => catalog.importLegacy(invalid, 0)).toThrow("INVALID_REGISTRY")
  expect(catalog.state().revision).toBe(0)
})

test("serializes imports across catalog connections and supports an empty registry", async () => {
  const second = await Catalog.open(path.join(base, "catalog.sqlite"), base)
  try {
    const result = catalog.importLegacy({ ...imported(), active: null, workspaces: [] }, 0)
    expect(second.importLegacy({ ...imported(), active: null, workspaces: [] }, 0)).toEqual(result)
    expect(second.state().revision).toBe(1)
    expect(() => second.importLegacy({ ...imported(), sourcePath: `${imported().sourcePath}.other` }, 0)).toThrow("REVISION_CONFLICT")
  } finally { second.close() }
})

test("upgrades the existing catalog schema without changing definitions or bindings", async () => {
  const saved = catalog.change({ requestID: crypto.randomUUID(), expectedRevision: 0, action: { kind: "create", name: "existing" } }, base, false)
  catalog.change({ requestID: crypto.randomUUID(), expectedRevision: saved.revision, sessionID: "ses_existing", action: { kind: "attach", workspaceID: saved.workspaces[0]!.id } }, base, true)
  catalog.capture("ses_existing", base)
  const before = catalog.state("ses_existing")
  catalog.close()
  const db = new Database(path.join(base, "catalog.sqlite"))
  db.exec("DROP TABLE imports; PRAGMA user_version=1")
  db.close()
  catalog = await Catalog.open(path.join(base, "catalog.sqlite"), base)
  expect(catalog.state("ses_existing")).toEqual(before)
  expect(catalog.importLegacy(imported(), before.revision).imported).toHaveLength(1)
})

async function legacy(value: unknown = { version: 1, active: "legacy", workspaces: { legacy: { name: "legacy", createdAt: "2026-10-19", roots: imported().workspaces[0]!.roots } } }) {
  const source = path.join(base, "workspaces.json")
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
  await fs.writeFile(source, bytes)
  return { source, bytes }
}
const signal = () => new AbortController().signal

test("rejects a malformed old catalog before changing its storage version or tables", async () => {
  const file = path.join(base, "malformed.sqlite")
  const previous = await Catalog.open(file, base)
  previous.change({ requestID: crypto.randomUUID(), expectedRevision: 0, action: { kind: "create", name: "existing" } }, base, false)
  previous.close()
  const db = new Database(file)
  db.exec("DROP TABLE imports; PRAGMA user_version=1; UPDATE workspaces SET data='{}'")
  db.close()
  await expect(Catalog.open(file, base)).rejects.toThrow("INVALID_REGISTRY")
  const check = new Database(file, { readonly: true })
  try {
    expect(check.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(1)
    expect(check.query("SELECT name FROM sqlite_master WHERE type='table' AND name='imports'").get()).toBeNull()
    expect(check.query<{ data: string }, []>("SELECT data FROM workspaces").get()!.data).toBe("{}")
  } finally { check.close() }
})

test("backs up exact source bytes before import without changing JSON or binding sessions", async () => {
  const { source, bytes } = await legacy()
  const preview = await previewLegacy(source, base, signal())
  const input = { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }
  const result = await importLegacy(catalog, input, base, signal())
  expect(await fs.readFile(source)).toEqual(bytes)
  expect(await fs.readFile(result.backupPath)).toEqual(bytes)
  expect(await importLegacy(catalog, input, base, signal())).toEqual(result)
  expect(catalog.selection("ses_any").binding).toBeNull()
  expect((await fs.readdir(base)).filter((file) => file.includes(".backup-"))).toHaveLength(1)
  await fs.unlink(source)
  expect(await importLegacy(catalog, input, base, signal())).toEqual(result)
})

test("rejects malformed/future/duplicate/traversal registries before creating a backup", async () => {
  const invalid = ["{", { version: 2, active: null, workspaces: {} }, { version: 1, active: "missing", workspaces: {} },
    { version: 1, active: null, workspaces: { legacy: { name: "legacy", createdAt: "", roots: [{ alias: "bad", path: "relative/../file" }] } } },
    { version: 1, active: null, workspaces: { legacy: { name: "legacy", createdAt: "", roots: [...imported().workspaces[0]!.roots, ...imported().workspaces[0]!.roots] } } },
    '{"version":1,"active":null,"workspaces":{"__proto__":{"name":"__proto__","createdAt":"","roots":[]}}}',
  ]
  for (const value of invalid) {
    const { source, bytes } = await legacy(value)
    await expect(previewLegacy(source, base, signal())).rejects.toThrow("INVALID_REGISTRY")
    await expect(importLegacy(catalog, { path: source, fingerprint: "a".repeat(64), expectedRevision: 0 }, base, signal())).rejects.toThrow("INVALID_REGISTRY")
    expect(await fs.readFile(source)).toEqual(bytes)
  }
  expect(catalog.state().workspaces).toEqual([])
  expect((await fs.readdir(base)).some((file) => file.includes(".backup-") || file.endsWith(".lock"))).toBe(false)
})

test("never overwrites a backup collision and can retry after a backup without catalog commit", async () => {
  const { source, bytes } = await legacy()
  const first = await backupLegacy(source, bytes, signal(), "same-time")
  const second = await backupLegacy(source, bytes, signal(), "same-time")
  expect(first).not.toBe(second)
  expect(await fs.readFile(first)).toEqual(bytes)
  const preview = await previewLegacy(source, base, signal())
  const result = await importLegacy(catalog, { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }, base, signal())
  expect(result.imported).toHaveLength(1)
  expect(await fs.readFile(first)).toEqual(bytes)
})

test("detects preview changes and cancellation while the legacy writer owns the lock", async () => {
  const { source } = await legacy()
  const preview = await previewLegacy(source, base, signal())
  await fs.appendFile(source, "\n")
  await expect(importLegacy(catalog, { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }, base, signal())).rejects.toThrow("IMPORT_CHANGED")
  const latest = await previewLegacy(source, base, signal())
  const unlock = await registryLock(source, signal())
  try {
    const abort = new AbortController()
    const pending = importLegacy(catalog, { path: source, fingerprint: latest.fingerprint, expectedRevision: 0 }, base, abort.signal)
    abort.abort(new Error("cancelled import"))
    await expect(pending).rejects.toThrow()
    expect(await fs.exists(`${source}.lock`)).toBe(true)
    expect(catalog.state().revision).toBe(0)
  } finally { await unlock() }
})

test("concurrent import calls share one receipt and backup", async () => {
  const { source } = await legacy()
  const preview = await previewLegacy(source, base, signal())
  const input = { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }
  const second = await Catalog.open(path.join(base, "catalog.sqlite"), base)
  try {
    const results = await Promise.all([importLegacy(catalog, input, base, signal()), importLegacy(second, input, base, signal())])
    expect(results[0]).toEqual(results[1])
    expect(catalog.state().workspaces).toHaveLength(1)
    expect((await fs.readdir(base)).filter((file) => file.includes(".backup-"))).toHaveLength(1)
  } finally { second.close() }
})

test("failed backup sync leaves source and catalog unchanged and permits a safe retry", async () => {
  const { source, bytes } = await legacy()
  const preview = await previewLegacy(source, base, signal())
  const input = { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }
  const original = fs.open
  const failure = new Error("backup sync failed")
  const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file).includes(".backup-")) handle.sync = async () => { throw failure }
    return handle
  })
  try { await expect(importLegacy(catalog, input, base, signal())).rejects.toBe(failure) } finally { open.mockRestore() }
  expect(await fs.readFile(source)).toEqual(bytes)
  expect(catalog.state().revision).toBe(0)
  expect(catalog.imported(preview.sourcePath, preview.fingerprint)).toBeUndefined()
  expect(await fs.exists(`${source}.lock`)).toBe(false)
  expect((await fs.readdir(base)).filter((file) => file.includes(".backup-"))).toHaveLength(1)
  expect((await importLegacy(catalog, input, base, signal())).imported).toHaveLength(1)
})

test("imports an empty file and rejects oversized or invalid-encoding registries", async () => {
  const { source } = await legacy({ version: 1, active: null, workspaces: {} })
  const preview = await previewLegacy(source, base, signal())
  expect((await importLegacy(catalog, { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }, base, signal())).imported).toEqual([])
  const other = path.join(base, "invalid.json")
  await fs.writeFile(other, Buffer.from([0xff, 0xfe]))
  await expect(previewLegacy(other, base, signal())).rejects.toThrow("INVALID_REGISTRY")
  await fs.writeFile(other, " ".repeat(4 * 1024 * 1024 + 1))
  await expect(previewLegacy(other, base, signal())).rejects.toThrow("INVALID_REGISTRY")
})

test("rejects a source changed during backup and retains a usable pre-change backup", async () => {
  const { source, bytes } = await legacy()
  const preview = await previewLegacy(source, base, signal())
  const original = fs.open
  const open = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await original(file, flags, mode)
    if (String(file).includes(".backup-")) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { await sync(); await fs.appendFile(source, "\n") }
    }
    return handle
  })
  try {
    await expect(importLegacy(catalog, { path: source, fingerprint: preview.fingerprint, expectedRevision: 0 }, base, signal())).rejects.toThrow("IMPORT_CHANGED")
  } finally { open.mockRestore() }
  expect(catalog.state().revision).toBe(0)
  const backups = (await fs.readdir(base)).filter((file) => file.includes(".backup-"))
  expect(backups).toHaveLength(1)
  expect(await fs.readFile(path.join(base, backups[0]!))).toEqual(bytes)
  const next = await previewLegacy(source, base, signal())
  expect((await importLegacy(catalog, { path: source, fingerprint: next.fingerprint, expectedRevision: 0 }, base, signal())).imported).toHaveLength(1)
})

test("conflicting names roll back the whole service import and leave pinned bindings intact", async () => {
  const original = catalog.importLegacy(imported(), 0)
  catalog.change({ requestID: crypto.randomUUID(), expectedRevision: 1, sessionID: "ses_pinned", action: { kind: "attach", workspaceID: original.imported[0]!.id } }, base, true)
  catalog.capture("ses_pinned", base)
  const before = catalog.state("ses_pinned")
  const { source } = await legacy({ version: 1, active: null, workspaces: {
    new: { name: "new", createdAt: "", roots: [] }, legacy: { name: "legacy", createdAt: "", roots: [] },
  } })
  const preview = await previewLegacy(source, base, signal())
  await expect(importLegacy(catalog, { path: source, fingerprint: preview.fingerprint, expectedRevision: before.revision }, base, signal())).rejects.toThrow("IMPORT_CHANGED")
  const different = path.join(base, "different.json")
  await fs.copyFile(source, different)
  await expect(importLegacy(catalog, { path: different, fingerprint: preview.fingerprint, expectedRevision: before.revision }, base, signal())).rejects.toThrow("WORKSPACE_EXISTS")
  expect(catalog.state("ses_pinned")).toEqual(before)
})