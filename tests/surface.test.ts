// Golden snapshot of everything a user, model or host can observe. A snapshot
// diff here is a behavior change: fix the code, never update the snapshot.
import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import Server from "../src/index.ts"
import { Catalog } from "../src/infrastructure/catalog.ts"
import { WorkspaceRPC } from "../src/rpc.ts"
import Tui from "../src/tui.ts"
import { tuiHost } from "./helpers/tui-host.ts"
import { workspaceServer } from "./helpers/workspace-server.ts"

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

// ses_a is attached to "alpha", which has one root with an AGENTS.md and the default alias.
async function activeServer() {
  const host = await server()
  await fs.writeFile(path.join(host.root, "AGENTS.md"), "SURFACE_ROOT_RULE\n")
  const workspace = (await host.change({ kind: "create", name: "alpha" })).workspaces[0]!
  await host.change({ kind: "addRoot", workspaceID: workspace.id, path: host.root })
  await host.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")
  return host
}

async function failure(attempt: () => Promise<unknown>) {
  try {
    await attempt()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const code = "code" in error && typeof error.code === "string" ? error.code : null
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : null
    return { code, tag, message: error.message }
  }
  throw new Error("Expected the operation to fail")
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
