// Golden snapshot of everything a user, model or host can observe. A snapshot
// diff here is a behavior change: fix the code, never update the snapshot.
import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { Alias, Name } from "../src/shared/schemas.ts"
import Server from "../src/index.ts"
import { Catalog } from "../src/infrastructure/catalog.ts"
import { WorkspaceRPC } from "../src/rpc.ts"
import Tui from "../src/tui.ts"
import type { Fake } from "./helpers/fake.ts"
import { tuiHost } from "./helpers/tui-host.ts"
import { workspaceServer } from "./helpers/workspace-server.ts"

type Host = Awaited<ReturnType<typeof workspaceServer>>
type TuiHost = Awaited<ReturnType<typeof tuiHost>>

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

// Temp paths appear raw, slash-normalized and JSON-escaped: once inside the
// instruction block, and once more when that text is serialized again.
function normalize(text: string, base: string) {
  const forms = new Set<string>()
  for (const form of [base, base.replaceAll("\\", "/")]) {
    let escaped = form
    for (let depth = 0; depth < 3; depth++) {
      forms.add(escaped)
      escaped = JSON.stringify(escaped).slice(1, -1)
    }
  }
  let result = text
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(form, "<base>")
  }
  return result.replace(UUID, "<uuid>")
}

// A JSON round trip drops undefined fields and functions, keeping only data.
// Multi-line strings become line arrays: Bun would print a nested one after a
// trailing space, which whitespace tooling could strip and so break the match.
function normalized(value: unknown, base: string): unknown {
  return JSON.parse(normalize(JSON.stringify(value), base), (_key, item: unknown) => {
    return typeof item === "string" && item.includes("\n") ? item.split("\n") : item
  })
}

async function server() {
  const host = await workspaceServer()
  disposers.push(() => host.dispose())
  return host
}

async function tui() {
  const host = await tuiHost()
  disposers.push(() => host.dispose())
  return host
}

// Saves "alpha" with the given roots under their default aliases and attaches ses_a.
async function attachAlpha(host: Host, roots: readonly string[] = [host.root]) {
  const workspace = (await host.change({ kind: "create", name: "alpha" })).workspaces[0]!
  for (const root of roots) {
    await host.change({ kind: "addRoot", workspaceID: workspace.id, path: root })
  }
  await host.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")
  return workspace
}

// ses_a is attached to "alpha", which has one root with an AGENTS.md and the default alias.
async function activeServer() {
  const host = await server()
  await fs.writeFile(path.join(host.root, "AGENTS.md"), "SURFACE_ROOT_RULE\n")
  await attachAlpha(host)
  return host
}

// Writes to a catalog file directly, as a corrupting or bulk-loading peer would.
function sql(file: string, statement: string, ...params: string[]) {
  const db = new Database(file)
  try {
    db.query(statement).run(...params)
  } finally {
    db.close()
  }
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) throw error
  const code = "code" in error && typeof error.code === "string" ? error.code : null
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : null
  return { code, tag, message: error.message }
}

async function failure(attempt: () => Promise<unknown>) {
  try {
    await attempt()
  } catch (error) {
    return describeError(error)
  }
  throw new Error("Expected the operation to fail")
}

async function outcome(attempt: () => Promise<unknown>) {
  try {
    await attempt()
    return "completed"
  } catch (error) {
    return describeError(error)
  }
}

// The dialog log as data, after checking the script consumed every queued answer.
function transcriptOf(h: TuiHost) {
  expect(h.answers).toEqual([])
  expect(h.names).toEqual([])
  expect(h.confirmations).toEqual([])
  return normalized(
    h.transcript.map(({ kind, options }) => ({ kind, ...options })),
    h.server.base,
  )
}

function pick(title: string) {
  return (options: DialogSelectOptions<string>) => {
    return options.options.find((option) => option.title === title)?.value
  }
}

test("tool surface", async () => {
  const h = await activeServer()
  const tools = [...h.tools.values()].map(({ name, description, input, options }) => {
    return { name, description, input, options }
  })
  expect(normalized(tools, h.base)).toMatchSnapshot()
})

test("system context text", async () => {
  const h = await activeServer()
  const event = h.request("ses_a")
  await h.context(event)
  const pushed = event.system.at(-1)
  if (pushed?.type !== "text") throw new Error("The context hook pushed no system text")
  expect(normalize(pushed.text, h.base)).toMatchSnapshot()
})

test("rpc contract", () => {
  const methods = Object.entries(WorkspaceRPC.methods).map(([name, method]) => {
    const errors = Object.entries(method.errors).map(([error, schema]) => {
      return [error, z.toJSONSchema(schema)]
    })
    return {
      name,
      input: z.toJSONSchema(method.input),
      output: z.toJSONSchema(method.output),
      errors: Object.fromEntries(errors),
    }
  })
  const events = { changed: z.toJSONSchema(WorkspaceRPC.events.changed.schema) }
  const plugins = { server: Server.id, tui: Tui.id }
  expect({ id: WorkspaceRPC.id, plugins, methods, events }).toMatchSnapshot()
})

test("catalog storage", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "surface-catalog-")))
  disposers.push(() => fs.rm(base, { recursive: true, force: true }))
  const file = path.join(base, "workspaces.sqlite")
  const catalog = await Catalog.open(file, base)
  catalog.close()
  const db = new Database(file, { readonly: true })
  try {
    const schema = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()
    const pragmas = {
      application_id: db.query("PRAGMA application_id").get(),
      user_version: db.query("PRAGMA user_version").get(),
      journal_mode: db.query("PRAGMA journal_mode").get(),
    }
    expect({ schema, pragmas }).toMatchSnapshot()
  } finally {
    db.close()
  }
})

test("menu transcript", async () => {
  const h = await tui()
  h.answers.push("create", "add", "paste", "add")
  h.answers.push("status")
  h.answers.push("switch", pick("alpha"), "here")
  h.answers.push("status")
  h.answers.push("delete", pick("alpha"), undefined)
  h.names.push("alpha", h.server.root, (options) => options.value)
  h.confirmations.push(false)
  await h.run()
  expect(h.answers).toEqual([])
  expect(h.names).toEqual([])
  expect(h.confirmations).toEqual([])
  const transcript = h.transcript.map(({ kind, options }) => ({ kind, ...options }))
  expect(normalized(transcript, h.server.base)).toMatchSnapshot()
})

test("commands", async () => {
  const h = await tui()
  const commands = h.commands.map(({ id, title, group, slash, palette }) => {
    return { id, title, group, slash, palette }
  })
  expect(commands).toMatchSnapshot()
})

test("error messages", async () => {
  const h = await activeServer()
  const other = path.join(h.base, "other folder")
  await fs.mkdir(other)
  const alpha = (await h.rpc.state()).workspaces[0]!
  const reused = crypto.randomUUID()
  const failures = {
    "change with a stale revision": await failure(async () => {
      const stale = (await h.rpc.state()).revision - 1
      const action = { kind: "create", name: "stale" } as const
      return h.rpc.change({ requestID: crypto.randomUUID(), expectedRevision: stale, action })
    }),
    "reused request ID with a different action": await failure(async () => {
      const { revision } = await h.rpc.state()
      const first = { kind: "create", name: "beta" } as const
      await h.rpc.change({ requestID: reused, expectedRevision: revision, action: first })
      const second = { kind: "create", name: "gamma" } as const
      return h.rpc.change({ requestID: reused, expectedRevision: revision + 1, action: second })
    }),
    "create with a duplicate name": await failure(() => {
      return h.change({ kind: "create", name: "alpha" })
    }),
    "addRoot with a duplicate explicit alias": await failure(() => {
      const alias = alpha.roots[0]!.alias
      return h.change({ kind: "addRoot", workspaceID: alpha.id, path: other, alias })
    }),
    "attach on a started session": await failure(async () => {
      await h.context(h.request("ses_b"))
      return h.change({ kind: "attach", workspaceID: alpha.id }, "ses_b")
    }),
    "workspace_status on a passive session": await failure(() => {
      return h.execute("workspace_status", {}, "ses_child")
    }),
    "workspace_resolve with an unknown alias": await failure(() => {
      return h.execute("workspace_resolve", { path: "nope:/x" }, "ses_a")
    }),
    "native glob over a bound root": await failure(() => {
      return h.before("glob", { path: h.root }, "ses_a")
    }),
    "native read with a relative path": await failure(() => {
      return h.before("read", { path: "relative.txt" }, "ses_a")
    }),
  }
  expect(normalized(failures, h.base)).toMatchSnapshot()
})

// Tool results: the JSON each helper tool returns to the model.

test("tool results", async () => {
  const h = await activeServer()
  await fs.mkdir(path.join(h.root, "src"))
  await fs.writeFile(path.join(h.root, "src", "app.ts"), "export const SURFACE = 1\n")
  await fs.writeFile(path.join(h.root, "long.txt"), `SURFACE ${"x".repeat(2000)}\n`)
  const hits = Array.from({ length: 101 }, (_, index) => `hit ${index + 1}`)
  await fs.writeFile(path.join(h.root, "many.txt"), `${hits.join("\n")}\n`)
  const results = {
    status: await h.execute("workspace_status", {}),
    resolve: await h.execute("workspace_resolve", { path: "external-docs:/src/app.ts" }),
    glob: await h.execute("workspace_glob", { pattern: "**/*" }),
    grep: await h.execute("workspace_grep", { pattern: "SURFACE" }),
    "grep beyond the result quota": await h.execute("workspace_grep", {
      pattern: "^hit",
      include: "many.txt",
    }),
  }
  expect(normalized({ results, permissions: h.permissions }, h.base)).toMatchSnapshot()
})

test("tool results: partial search", async () => {
  const h = await server()
  const ignored = path.join(h.base, "ignored root")
  const gone = path.join(h.base, "gone root")
  await fs.mkdir(ignored)
  await fs.mkdir(gone)
  await fs.writeFile(path.join(h.root, "notes.md"), "SURFACE\n")
  await fs.writeFile(path.join(ignored, ".gitignore"), "#".repeat(200 * 1024 + 1))
  await attachAlpha(h, [h.root, ignored, gone])
  await fs.rm(gone, { recursive: true })
  const result = await h.execute("workspace_glob", { pattern: "**/*" })
  expect(normalized(result, h.base)).toMatchSnapshot()
})

// Instruction delivery: the blocked and metadata-only variants of the block.

function agents(directory: string) {
  return path.join(directory, "AGENTS.md")
}

// Attaches ses_a to the roots `prepare` returns, then records one request's delivery.
async function instructionCase(prepare: (host: Host) => Promise<readonly string[]>) {
  const h = await server()
  const roots = await prepare(h)
  await attachAlpha(h, roots)
  const event = h.request("ses_a")
  await h.context(event)
  const pushed = event.system.at(-1)
  if (pushed?.type !== "text") throw new Error("The context hook pushed no system text")
  const { instructions } = await h.rpc.selection({ sessionID: "ses_a" })
  const preflight = await outcome(() => h.before("write", { path: `${roots[0]}/new.txt` }))
  return normalized({ system: pushed.text, instructions, preflight }, h.base)
}

test("instruction delivery variants", async () => {
  const variants = {
    "missing source": await instructionCase(async (h) => [h.root]),
    "oversized source": await instructionCase(async (h) => {
      await fs.writeFile(agents(h.root), "x".repeat(32 * 1024 + 1))
      return [h.root]
    }),
    "invalid UTF-8 source": await instructionCase(async (h) => {
      await fs.writeFile(agents(h.root), Buffer.from([0x72, 0xff, 0x0a]))
      return [h.root]
    }),
    "binary source": await instructionCase(async (h) => {
      await fs.writeFile(agents(h.root), "rule\0text\n")
      return [h.root]
    }),
    "non-regular source": await instructionCase(async (h) => {
      await fs.mkdir(agents(h.root))
      return [h.root]
    }),
    "aggregate overflow": await instructionCase(async (h) => {
      const roots = ["first", "second", "third"].map((name) => path.join(h.base, `${name} root`))
      for (const root of roots) {
        await fs.mkdir(root)
        await fs.writeFile(agents(root), "y".repeat(30_000))
      }
      return roots
    }),
    "small model context": await instructionCase(async (h) => {
      await fs.writeFile(agents(h.root), "SURFACE_ROOT_RULE\n")
      h.setContextLimit(32_000)
      return [h.root]
    }),
  }
  expect(variants).toMatchSnapshot()
})

// Validation rules that JSON Schema cannot express (trim and refine).

function validation(schema: z.ZodType, value: string) {
  const result = schema.safeParse(value)
  return result.success ? { data: result.data } : { issues: result.error.issues }
}

test("name and alias validation", () => {
  // Label/value pairs, not an object: a "__proto__" key would set the prototype.
  const names: [string, string][] = [
    ["plain", "alpha"],
    ["padded", "  padded  "],
    ["empty", ""],
    ["blank", "   "],
    ["tab inside", "tab\there"],
    ["DEL inside", "delete\u007f"],
    ["__proto__", "__proto__"],
    ["Prototype", "Prototype"],
    ["CONSTRUCTOR", "CONSTRUCTOR"],
    ["padded reserved word", " constructor "],
    ["100 characters", "n".repeat(100)],
    ["101 characters", "n".repeat(101)],
    ["non-ASCII", "ünïcode ✓"],
  ]
  const aliases: [string, string][] = [
    ["plain", "docs"],
    ["digits, dash and underscore", "my_root-2"],
    ["empty", ""],
    ["uppercase", "Docs"],
    ["space", "has space"],
    ["dot", "a.b"],
    ["100 characters", "a".repeat(100)],
    ["101 characters", "a".repeat(101)],
  ]
  const results = {
    names: names.map(([label, value]) => [label, validation(Name, value)]),
    aliases: aliases.map(([label, value]) => [label, validation(Alias, value)]),
  }
  expect(JSON.parse(JSON.stringify(results))).toMatchSnapshot()
})

// Error messages beyond the original nine scenarios.

test("error messages: administration", async () => {
  const h = await activeServer()
  const alpha = (await h.rpc.state()).workspaces[0]!
  const created = await h.change({ kind: "create", name: "doomed" })
  const doomed = created.workspaces.find((workspace) => workspace.name === "doomed")!
  await h.change({ kind: "remove", workspaceID: doomed.id })
  const filled = await h.change({ kind: "create", name: "full" })
  const full = filled.workspaces.find((workspace) => workspace.name === "full")!
  const folders = Array.from({ length: 21 }, (_, index) => {
    return path.join(h.base, "folders", `f${index}`)
  })
  for (const folder of folders) await fs.mkdir(folder, { recursive: true })
  for (const folder of folders.slice(0, 20)) {
    await h.change({ kind: "addRoot", workspaceID: full.id, path: folder })
  }
  await fs.mkdir(path.join(h.base, ".ssh"))
  h.addSession("ses_elsewhere", h.root)
  const addRoot = (workspaceID: typeof alpha.id, folder: string) => {
    return failure(() => h.change({ kind: "addRoot", workspaceID, path: folder }))
  }
  const active = {
    "remove an unknown workspace": await failure(() => {
      return h.change({ kind: "remove", workspaceID: doomed.id })
    }),
    "removeRoot with an unknown alias": await failure(() => {
      return h.change({ kind: "removeRoot", workspaceID: alpha.id, alias: "missing" })
    }),
    "attach without a session": await failure(() => {
      return h.change({ kind: "attach", workspaceID: alpha.id })
    }),
    "addRoot of a file": await addRoot(alpha.id, agents(h.root)),
    "addRoot of a sensitive folder": await addRoot(alpha.id, path.join(h.base, ".ssh")),
    "addRoot of a missing folder": await addRoot(alpha.id, path.join(h.base, "missing")),
    "addRoot beyond the folder limit": await addRoot(full.id, folders[20]!),
    "state of a session in another Location": await failure(() => {
      return h.rpc.state({ sessionID: "ses_elsewhere" })
    }),
  }
  const fresh = await server()
  const missing = await failure(() => fresh.change({ kind: "detach" }, "ses_a"))
  // Unload while the first catalog lookup is still in flight.
  const pending = failure(() => fresh.rpc.state())
  await fresh.reload()
  const unloaded = await pending
  const freshFailures = {
    "detach before the catalog exists": missing,
    "state during unload": unloaded,
  }
  expect({
    active: normalized(active, h.base),
    fresh: normalized(freshFailures, fresh.base),
  }).toMatchSnapshot()
})

// A fresh host whose catalog `prepare` shaped before the plugin first reads it.
async function storageFailure(prepare: (host: Host) => Promise<unknown> | void) {
  const h = await server()
  await fs.mkdir(path.dirname(h.catalogPath), { recursive: true })
  await prepare(h)
  return normalized(await failure(() => h.rpc.state({ sessionID: "ses_a" })), h.base)
}

test("error messages: catalog storage", async () => {
  const blank = { options: { catalogPath: " " } } satisfies Fake<Plugin.Context>
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "surface-storage-")))
  disposers.push(() => fs.rm(base, { recursive: true, force: true }))
  const failures = {
    "blank catalogPath option": await failure(async () => {
      return Server.setup(blank as unknown as Plugin.Context)
    }),
    "catalog without the .sqlite extension": await failure(() => {
      return Catalog.existing(path.join(base, "workspaces.db"), base)
    }),
    "catalog path that is a folder": await storageFailure((h) => fs.mkdir(h.catalogPath)),
    "catalog file that is not SQLite": await storageFailure((h) => {
      return fs.writeFile(h.catalogPath, "x".repeat(1024))
    }),
    "foreign SQLite database": await storageFailure((h) => {
      sql(h.catalogPath, "CREATE TABLE other (value TEXT)")
    }),
    "unsupported storage version": await storageFailure((h) => {
      sql(h.catalogPath, "PRAGMA application_id=1465077042")
      sql(h.catalogPath, "PRAGMA user_version=3")
    }),
    "invalid catalog metadata": await storageFailure(async (h) => {
      await h.seed()
      sql(h.catalogPath, "UPDATE catalog SET catalogID = 'invalid'")
    }),
    "invalid stored workspace": await storageFailure(async (h) => {
      await h.seed()
      sql(h.catalogPath, "UPDATE workspaces SET data = '{}'")
    }),
    "invalid session binding": await storageFailure(async (h) => {
      await h.seed()
      sql(h.catalogPath, "INSERT INTO bindings VALUES ('ses_a', 'relative', NULL, 0)")
    }),
  }
  expect(failures).toMatchSnapshot()
})

const FILL_WORKSPACES = `WITH RECURSIVE n(i) AS
  (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
  INSERT INTO workspaces
  SELECT id, json_object('id', id, 'name', 'fill-' || i, 'revision', 1, 'roots', json('[]'))
  FROM (SELECT i, printf('00000000-0000-4000-8000-%012d', i) AS id FROM n)`
const FILL_BINDINGS = `WITH RECURSIVE n(i) AS
  (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
  INSERT INTO bindings SELECT 'ses_fill_' || i, ?, NULL, 0 FROM n`

test("error messages: bindings and limits", async () => {
  const moved = await server()
  const movedAlpha = (await moved.seed()).workspaces[0]!
  const elsewhere = `${moved.base.replaceAll("\\", "/")}/elsewhere`
  const relocate = "INSERT INTO bindings SELECT 'ses_a', ?, data, 0 FROM workspaces"
  sql(moved.catalogPath, relocate, elsewhere)
  const location = {
    "attach over a binding from another Location": await failure(() => {
      return moved.change({ kind: "attach", workspaceID: movedAlpha.id }, "ses_a")
    }),
    "selection of a binding from another Location": await failure(() => {
      return moved.rpc.selection({ sessionID: "ses_a" })
    }),
  }

  const crowded = await server()
  const crowdedAlpha = (await crowded.seed()).workspaces[0]!
  sql(crowded.catalogPath, FILL_WORKSPACES)
  sql(crowded.catalogPath, FILL_BINDINGS, crowded.directory)
  const limits = {
    "create beyond 1000 workspaces": await failure(() => {
      return crowded.change({ kind: "create", name: "overflow" })
    }),
    "attach beyond 10000 bindings": await failure(() => {
      return crowded.change({ kind: "attach", workspaceID: crowdedAlpha.id }, "ses_b")
    }),
  }

  const vanished = await activeServer()
  const reader = (await Catalog.existing(vanished.catalogPath, vanished.directory))!
  const confirmed = reader.selection("ses_a")
  reader.close()
  sql(vanished.catalogPath, "DELETE FROM bindings WHERE sessionID = 'ses_a'")
  const selection = await failure(() => vanished.rpc.selection({ sessionID: "ses_a" }))
  // The lookup still reports the binding, but it is gone when the tool captures it.
  const lookup = spyOn(Catalog.prototype, "selection").mockReturnValue(confirmed)
  let status: unknown
  try {
    status = await failure(() => vanished.execute("workspace_status", {}))
  } finally {
    lookup.mockRestore()
  }
  const lost = {
    "selection after a known active binding vanished": selection,
    "workspace_status after its binding vanished": status,
  }

  expect({
    location: normalized(location, moved.base),
    limits: normalized(limits, crowded.base),
    lost: normalized(lost, vanished.base),
  }).toMatchSnapshot()
})

test("error messages: tools and native preflight", async () => {
  const h = await activeServer()
  const target = `${h.root}/new.txt`
  const outside = path.join(h.base, "outside")
  await fs.mkdir(outside)
  const link = process.platform === "win32" ? "junction" : "dir"
  await fs.symlink(outside, path.join(h.root, "linked"), link)
  const failures: Record<string, unknown> = {}
  const write = () => h.before("write", { path: target })

  failures["native write before any workspace request"] = await failure(write)
  await h.context(h.request("ses_a"))
  await fs.writeFile(agents(h.root), "CHANGED_ROOT_RULE\n")
  failures["native write after its instructions changed"] = await failure(write)
  await h.compact(h.request("ses_a"))
  failures["native write after compaction"] = await failure(write)
  h.setContextLimit(32_000)
  await h.context(h.request("ses_a"))
  failures["native write with an unverified small context"] = await failure(write)

  // Each of these fails before instruction preflight, whatever the delivery state.
  const attempts = {
    "native patch with unsupported framing": () => h.before("patch", { patchText: "not a patch" }),
    "native shell without a workdir": () => h.before("shell", {}),
    "native read with a control character": () => h.before("read", { path: "bad\u0001name" }),
    "native read of a drive-relative path": () => h.before("read", { path: "C:relative.txt" }),
    "native read of a reserved Windows name": () => h.before("read", { path: `${h.root}/con.txt` }),
    "native write of a sensitive file": () => h.before("write", { path: `${h.root}/.env` }),
    "native read through a linked folder": () => {
      return h.before("read", { path: `${h.root}/linked/file.txt` })
    },
    "workspace_resolve with alias traversal": () => {
      return h.execute("workspace_resolve", { path: "external-docs:/../x" })
    },
    "workspace_resolve without a path": () => h.execute("workspace_resolve", {}),
    "workspace_glob with invalid arguments": () => h.execute("workspace_glob", {}),
    "workspace_glob with parent traversal": () => h.execute("workspace_glob", { pattern: "../*" }),
    "workspace_glob with conflicting aliases": () => {
      return h.execute("workspace_glob", { pattern: "external-docs:/*", alias: "other" })
    },
    "workspace_glob with an unknown alias": () => {
      return h.execute("workspace_glob", { pattern: "*", alias: "nope" })
    },
    "workspace_grep with a NUL character": () => {
      return h.execute("workspace_grep", { pattern: "a\u0000" })
    },
    "workspace_grep with an invalid regex": () => h.execute("workspace_grep", { pattern: "(" }),
  }
  for (const [label, attempt] of Object.entries(attempts)) failures[label] = await failure(attempt)

  // Last, because it retargets the root itself: the root path now links elsewhere.
  await fs.rename(h.root, `${h.root} moved`)
  await fs.symlink(`${h.root} moved`, h.root, link)
  failures["native read after the root became a link"] = await failure(() => {
    return h.before("read", { path: agents(h.root) })
  })
  expect(normalized(failures, h.base)).toMatchSnapshot()
})

test("error messages: instruction scope limit", async () => {
  const h = await activeServer()
  await h.context(h.request("ses_a"))
  // Each resolved folder becomes another instruction scope for the next request.
  for (let index = 1; index <= 128; index++) {
    await fs.mkdir(path.join(h.root, `scope-${index}`))
    await h.execute("workspace_resolve", { path: `external-docs:/scope-${index}` })
  }
  const request = await failure(() => h.context(h.request("ses_a")))
  const { instructions } = await h.rpc.selection({ sessionID: "ses_a" })
  expect(normalized({ request, instructions }, h.base)).toMatchSnapshot()
})

test("console warnings", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const h = await server()
    // A folder where the catalog file belongs makes binding resolution unavailable.
    await fs.mkdir(h.catalogPath, { recursive: true })
    await h.context(h.request("ses_a"))
    for (let index = 0; index < 10_000; index++) await h.compact(h.request(`ses_started_${index}`))
    expect(normalized(warning.mock.calls, h.base)).toMatchSnapshot()
  } finally {
    warning.mockRestore()
  }
})

// Menu transcripts beyond the happy path.

test("menu: unavailable session metadata", async () => {
  const h = await tui()
  h.cached(false)
  await h.run()
  expect(transcriptOf(h)).toMatchSnapshot()
})

test("menu: empty catalog", async () => {
  const h = await tui()
  await h.run("workspace-switch")
  await h.run("workspace-add")
  const alpha = (await h.server.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await h.server.change({ kind: "addRoot", workspaceID: alpha.id, path: h.server.root })
  // The folder is removed after the menu offered removal, so the chooser finds none.
  h.answers.push(async () => {
    await h.server.change({ kind: "removeRoot", workspaceID: alpha.id, alias: "external-docs" })
    return "root"
  }, undefined)
  await h.run()
  expect(transcriptOf(h)).toMatchSnapshot()
})

test("menu: invalid name", async () => {
  const h = await tui()
  h.answers.push("create", undefined)
  h.names.push("__proto__")
  await h.run()
  expect(transcriptOf(h)).toMatchSnapshot()
})

test("menu: folder errors", async () => {
  const h = await tui()
  await fs.mkdir(path.join(h.server.root, "nested"))
  const alpha = (await h.server.change({ kind: "create", name: "alpha" })).workspaces[0]!
  h.answers.push(pick("alpha"), "paste", pick("nested/"), "add", undefined)
  h.names.push(path.join(h.server.base, "missing"), h.server.root, "Bad Alias")
  await h.run("workspace-add")
  await h.server.change({ kind: "addRoot", workspaceID: alpha.id, path: h.server.root })
  h.answers.push(pick("alpha"), "paste", "add")
  h.names.push(h.server.root)
  await h.run("workspace-add")
  expect(transcriptOf(h)).toMatchSnapshot()
})

test("menu: bound empty session", async () => {
  const h = await tui()
  const second = path.join(h.server.base, "second")
  await fs.mkdir(second)
  const alpha = (await h.server.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await h.server.change({ kind: "addRoot", workspaceID: alpha.id, path: h.server.root })
  await h.server.change({ kind: "attach", workspaceID: alpha.id }, "ses_a")
  h.answers.push("add", "paste", "add", "apply")
  h.answers.push("root", "second", "detach", undefined)
  h.names.push(second, (options) => options.value)
  h.confirmations.push(true)
  await h.run()
  expect(transcriptOf(h)).toMatchSnapshot()
})

test("menu: started session", async () => {
  const h = await tui()
  const second = path.join(h.server.base, "second")
  const third = path.join(h.server.base, "third")
  await fs.mkdir(second)
  await fs.mkdir(third)
  const alpha = (await h.server.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await h.server.change({ kind: "addRoot", workspaceID: alpha.id, path: h.server.root })
  await h.server.change({ kind: "attach", workspaceID: alpha.id }, "ses_a")
  await h.server.context(h.server.request("ses_a"))
  await h.server.change({ kind: "addRoot", workspaceID: alpha.id, path: second })
  // Status shows the newer saved revision; detaching opens an ordinary session.
  h.answers.push("status", "add", "paste", "add", "keep", "detach")
  h.names.push(third, (options) => options.value)
  await h.run()
  // A started session can only open the saved workspace in a new session.
  h.route({ type: "session", sessionID: "ses_a" })
  h.answers.push("switch", pick("alpha"), "new")
  await h.run()
  // The definition is deleted and the last request was blocked by its budget.
  h.route({ type: "session", sessionID: "ses_a" })
  await h.server.change({ kind: "remove", workspaceID: alpha.id })
  h.server.setContextLimit(32_000)
  await h.server.context(h.server.request("ses_a"))
  h.answers.push("status", undefined)
  await h.run()
  const sessions = normalized({ created: h.created, navigations: h.navigations }, h.server.base)
  expect({ transcript: transcriptOf(h), sessions }).toMatchSnapshot()
})

test("menu: action stopped", async () => {
  const h = await tui()
  // Another client commits first, so this menu's create carries a stale revision.
  h.answers.push(async () => {
    await h.server.change({ kind: "create", name: "other" })
    return "create"
  })
  h.names.push("beta")
  await h.run()
  expect(transcriptOf(h)).toMatchSnapshot()
})
