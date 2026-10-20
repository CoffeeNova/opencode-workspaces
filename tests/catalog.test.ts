import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { type Action, type Change } from "../src/shared/schemas.ts"
import { Catalog } from "../src/infrastructure/catalog.ts"
import { slash } from "../src/server/filesystem/paths.ts"

let base: string
const connections: Catalog[] = []
const localAppData = process.env.LOCALAPPDATA
beforeEach(async () => {
  const parent = path.join(tmpdir(), "opencode")
  await fs.mkdir(parent, { recursive: true })
  base = await fs.realpath(await fs.mkdtemp(path.join(parent, "workspace-catalog-test-")))
})
afterEach(async () => {
  for (const catalog of connections.splice(0)) catalog.close()
  if (localAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = localAppData
  await fs.rm(base, { recursive: true, force: true })
})
const file = () => path.join(base, "catalog", "workspaces.sqlite")
async function open() {
  const catalog = await Catalog.open(file(), base)
  connections.push(catalog)
  return catalog
}
function change(
  catalog: Catalog,
  action: Action,
  sessionID?: string,
  empty = false,
  root?: string,
) {
  return catalog.change(
    {
      requestID: crypto.randomUUID(),
      expectedRevision: catalog.state().revision,
      ...(sessionID ? { sessionID } : {}),
      action,
    },
    base,
    empty,
    root,
  )
}
function inspect<T>(query: string) {
  const db = new Database(file(), { readonly: true })
  try {
    return db.query<T, []>(query).all()
  } finally {
    db.close()
  }
}

test("missing catalog discovery and active-only open never create a parent or file", async () => {
  expect(await Catalog.existing(file(), base)).toBeUndefined()
  await expect(Catalog.open(file(), base, false)).rejects.toThrow("CATALOG_UNAVAILABLE")
  expect(await fs.exists(path.dirname(file()))).toBe(false)
})

test("new catalogs contain only the current schema and read-only discovery cannot write", async () => {
  const catalog = await open()
  expect(inspect("PRAGMA user_version")).toEqual([{ user_version: 2 }])
  expect(inspect("PRAGMA application_id")).toEqual([{ application_id: 0x57534d32 }])
  expect(
    inspect<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((row) => row.name),
  ).toEqual(["bindings", "catalog", "receipts", "workspaces"])
  const reader = await Catalog.existing(file(), base)
  if (!reader) throw new Error("Existing catalog was not discovered")
  connections.push(reader)
  expect(reader.state()).toEqual(catalog.state())
  expect(() => change(reader, { kind: "create", name: "must-not-write" })).toThrow(/read.?only/i)
  expect(catalog.state().revision).toBe(0)
})

test("status, selection and unbound capture never insert or seal an ordinary session", async () => {
  const catalog = await open()
  change(catalog, { kind: "create", name: "saved" })
  for (const sessionID of ["ses_a", "ses_b"]) {
    expect(catalog.state(sessionID).binding).toBeNull()
    expect(catalog.selection(sessionID).binding).toBeNull()
    expect(catalog.capture(sessionID, base)).toBeNull()
  }
  expect(inspect("SELECT * FROM bindings")).toEqual([])
})

test("sessions keep independent pinned snapshots after definition edits and deletion", async () => {
  const catalog = await open()
  const alpha = change(catalog, { kind: "create", name: "alpha" }).workspaces[0]!
  const beta = change(catalog, { kind: "create", name: "beta" }).workspaces.find(
    (workspace) => workspace.name === "beta",
  )!
  change(catalog, { kind: "attach", workspaceID: alpha.id }, "ses_a", true)
  change(catalog, { kind: "attach", workspaceID: beta.id }, "ses_b", true)
  catalog.capture("ses_a", base)
  const pinned = catalog.selection("ses_a").binding
  const root = slash(path.join(base, "new root"))
  await fs.mkdir(root)
  change(
    catalog,
    { kind: "addRoot", workspaceID: alpha.id, path: root, alias: "docs" },
    undefined,
    false,
    root,
  )
  change(catalog, { kind: "remove", workspaceID: alpha.id })
  expect(catalog.selection("ses_a").binding).toEqual(pinned)
  expect(catalog.selection("ses_b").binding?.workspace?.id).toBe(beta.id)
  expect(catalog.selection("ses_b").binding?.sealed).toBe(false)
  expect(catalog.selection("ses_child").binding).toBeNull()
  expect(await fs.exists(root)).toBe(true)
})

test("started or sealed sessions reject attach/detach without partial changes", async () => {
  const catalog = await open()
  const workspace = change(catalog, { kind: "create", name: "alpha" }).workspaces[0]!
  expect(() =>
    change(catalog, { kind: "attach", workspaceID: workspace.id }, "ses_started"),
  ).toThrow("SESSION_STARTED")
  expect(inspect("SELECT * FROM bindings")).toEqual([])
  change(catalog, { kind: "attach", workspaceID: workspace.id }, "ses_a", true)
  catalog.capture("ses_a", base)
  const before = catalog.state("ses_a")
  expect(() => change(catalog, { kind: "detach" }, "ses_a", true)).toThrow("SESSION_STARTED")
  expect(() =>
    change(catalog, { kind: "attach", workspaceID: workspace.id }, "ses_a", true),
  ).toThrow("SESSION_STARTED")
  expect(catalog.state("ses_a")).toEqual(before)
})

test("idempotent attach retries survive sealing and revision conflicts do not duplicate writes", async () => {
  const catalog = await open()
  const workspace = change(catalog, { kind: "create", name: "alpha" }).workspaces[0]!
  const input: Change = {
    requestID: crypto.randomUUID(),
    expectedRevision: catalog.state().revision,
    sessionID: "ses_a",
    action: { kind: "attach", workspaceID: workspace.id },
  }
  catalog.change(input, base, true)
  catalog.capture("ses_a", base)
  const before = catalog.state("ses_a")
  expect(catalog.change(input, base, false)).toEqual(before)
  expect(() => catalog.change({ ...input, action: { kind: "detach" } }, base, true)).toThrow(
    "REQUEST_CONFLICT",
  )
  const other = await open()
  expect(() =>
    other.change(
      {
        requestID: crypto.randomUUID(),
        expectedRevision: 0,
        action: { kind: "create", name: "stale" },
      },
      base,
      false,
    ),
  ).toThrow("REVISION_CONFLICT")
  expect(catalog.state("ses_a")).toEqual(before)
})

test("current catalog identity and sealed bindings survive reopening without root discovery", async () => {
  const catalog = await open()
  const workspace = change(catalog, { kind: "create", name: "alpha" }).workspaces[0]!
  change(catalog, { kind: "attach", workspaceID: workspace.id }, "ses_a", true)
  catalog.capture("ses_a", base)
  const before = catalog.state("ses_a")
  connections.splice(connections.indexOf(catalog), 1)
  catalog.close()
  expect((await open()).state("ses_a")).toEqual(before)
})

test.each([0, 1, 3])(
  "storage version %i is rejected by both open paths without upgrade or overwrite",
  async (version) => {
    const catalog = await open()
    change(catalog, { kind: "create", name: "keep-me" })
    connections.splice(connections.indexOf(catalog), 1)
    catalog.close()
    const db = new Database(file())
    db.exec(`PRAGMA user_version=${version}`)
    db.close()
    const before = await fs.readFile(file())
    await expect(Catalog.existing(file(), base)).rejects.toThrow(
      `Unsupported catalog storage version ${version}`,
    )
    await expect(Catalog.open(file(), base)).rejects.toThrow(
      `Unsupported catalog storage version ${version}`,
    )
    expect(await fs.readFile(file())).toEqual(before)
    expect(inspect("PRAGMA user_version")).toEqual([{ user_version: version }])
    expect(inspect<{ data: string }>("SELECT data FROM workspaces")[0]!.data).toContain("keep-me")
  },
)

test("foreign/corrupt databases and JSON paths are rejected without replacing bytes", async () => {
  await fs.mkdir(path.dirname(file()))
  const db = new Database(file(), { create: true })
  db.exec("CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep-me')")
  db.close()
  for (const bytes of [await fs.readFile(file()), Buffer.from("not a SQLite database")]) {
    await fs.writeFile(file(), bytes)
    await expect(Catalog.existing(file(), base)).rejects.toThrow()
    await expect(Catalog.open(file(), base)).rejects.toThrow()
    expect(await fs.readFile(file())).toEqual(bytes)
  }
  const json = path.join(base, "workspaces.json")
  const bytes = Buffer.from('{"version":1,"workspaces":{}}')
  await fs.writeFile(json, bytes)
  await expect(Catalog.open(json, base)).rejects.toThrow(".sqlite path")
  await expect(Catalog.existing(json, base)).rejects.toThrow(".sqlite path")
  expect(await fs.readFile(json)).toEqual(bytes)
})

test("defaults use the OpenCode configuration directory without filesystem or old-path discovery", async () => {
  const expected = path.join(
    homedir(),
    ".config",
    "opencode",
    "workspace-manager",
    "workspaces-v2.sqlite",
  )
  const lstat = spyOn(fs, "lstat")
  const mkdir = spyOn(fs, "mkdir")
  try {
    for (const local of [path.join(base, "local-data"), undefined, "", "relative-data"]) {
      if (local === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = local
      expect(await Catalog.defaultPath()).toBe(expected)
    }
    expect(lstat).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  } finally {
    lstat.mockRestore()
    mkdir.mockRestore()
  }
})
