import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/plugin"
import type { DialogSelectOptions, KeymapLayer, Route } from "@opencode/plugin/tui/context"
import * as fs from "node:fs/promises"
import { type Change } from "../src/domain.ts"
import { WorkspaceRPC } from "../src/rpc.ts"
import Tui from "../src/tui.ts"
import { workspaceServer } from "./helpers/workspace-server.ts"
import type { Fake } from "./helpers/fake.ts"

type Options = { location: { directory: string }; signal: AbortSignal }
type Answer = string | undefined | Promise<string | undefined> | ((options: DialogSelectOptions<string>) => string | undefined | Promise<string | undefined>)

async function fixture(initial: Route = { type: "session", sessionID: "ses_a" }) {
  const server = await workspaceServer()
  const answers: Answer[] = []
  const names: string[] = []
  const selections: DialogSelectOptions<string>[] = []
  const alerts: { title: string; message: string }[] = []
  const calls: { method: string; input: unknown; options: Options }[] = []
  const created: { id: string; input: unknown }[] = []
  const navigations: Route[] = []
  const forbidden: string[] = []
  const slots: string[] = []
  let current = initial
  let cached = true
  let layer: KeymapLayer | undefined
  let unregistered = 0
  let holdAttach: (() => Promise<void>) | undefined
  const record = (method: string, input: unknown, options: Options) => { calls.push({ method, input, options }) }
  const rpc = {
    state: (input: { sessionID?: string }, options: Options) => { record("state", input, options); return server.rpc.state(input, options.signal) },
    selection: (input: { sessionID: string }, options: Options) => { record("selection", input, options); return server.rpc.selection(input) },
    change: async (input: Change, options: Options) => {
      record("change", input, options)
      const state = await server.rpc.change(input, options.signal)
      if (input.action.kind === "attach") await holdAttach?.()
      return state
    },
    browse: (input: { path?: string }, options: Options) => { record("browse", input, options); return server.rpc.browse(input) },
  }
  const client = new Proxy({
    rpc: (definition: typeof WorkspaceRPC) => {
      if (definition !== WorkspaceRPC) throw new Error("Unexpected RPC definition")
      return rpc
    },
    session: {
      create: async (input: unknown) => {
        const id = server.addSession(`ses_created_${created.length + 1}`)
        created.push({ id, input })
        return { id }
      },
    },
  }, { get(target, key) {
    if (key === "rpc") return target.rpc
    if (key === "session") return target.session
    forbidden.push(String(key))
    throw new Error(`Unexpected TUI client operation ${String(key)}`)
  } })
  const context = {
    location: { directory: server.directory }, client,
    data: {
      location: { default: () => ({ directory: server.directory }) },
      session: { get: (id: string) => cached && server.sessions.has(id) ? { location: { directory: server.sessions.get(id)!.directory } } : undefined },
    },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
    ui: {
      router: { current: () => current, navigate: (route: Route) => { navigations.push(route); current = route } },
      slot: (input: { append: string }) => { slots.push(input.append); return () => { unregistered++ } },
      toast: { show: () => {} },
      dialog: {
        select: async (options: DialogSelectOptions<string>) => {
          selections.push(options)
          if (!answers.length) throw new Error(`Unexpected selection dialog: ${options.title}`)
          const answer = answers.shift()
          return typeof answer === "function" ? answer(options) : answer
        },
        prompt: async () => {
          if (!names.length) throw new Error("Unexpected name prompt")
          return names.shift()
        },
        alert: async (input: { title: string; message: string }) => { alerts.push(input) },
      },
    },
  } satisfies Fake<Context> as unknown as Context
  let initialized: Awaited<ReturnType<typeof Tui.setup>>
  try { initialized = await Tui.setup(context) }
  catch (error) { await server.dispose(); throw error }
  if (!layer?.commands || typeof initialized !== "function") {
    await server.dispose()
    throw new Error("Workspace TUI did not register commands/cleanup")
  }
  const cleanup = initialized
  const commands = layer.commands
  let unloaded = false
  const unload = () => { if (!unloaded) { unloaded = true; cleanup() } }
  return {
    server, answers, names, selections, alerts, calls, created, navigations, forbidden, slots, commands, unload,
    get unregistered() { return unregistered },
    route(value: Route) { current = value },
    cached(value: boolean) { cached = value },
    holdAttach(value: () => Promise<void>) { holdAttach = value },
    async run(name = "workspace") {
      const command = commands.find((command) => command.slash?.name === name)
      if (!command) throw new Error(`Missing slash command ${name}`)
      await command.run()
    },
    async dispose() { unload(); await server.dispose() },
  }
}

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose() })
async function setup(route?: Route) { const h = await fixture(route); fixtures.push(h); return h }

test("only singular workspace and the existing add/switch commands are registered without imposed shortcuts", async () => {
  const h = await setup()
  expect(h.commands.map((command) => command.slash?.name)).toEqual(["workspace", "workspace-add", "workspace-switch"])
  expect(h.commands.map((command) => command.id)).toEqual(["workspace-manager.workspace", "workspace-manager.workspace-add", "workspace-manager.workspace-switch"])
  for (const command of h.commands) { expect(command.palette).toBe(true); expect(command.bind).toBeUndefined() }
  expect(h.slots).toEqual(["prompt.footer.status"])
  expect(await fs.exists(h.server.catalogPath)).toBe(false)
})

test("opening/cancelling management or viewing passive status does not activate or initialize storage", async () => {
  const h = await setup()
  h.answers.push(undefined, "status", undefined)
  await h.run()
  await h.run()
  expect(h.calls.filter((call) => call.method === "change")).toEqual([])
  expect(h.created).toEqual([])
  expect(h.navigations).toEqual([])
  expect(h.alerts).toHaveLength(1)
  expect(h.alerts[0]!.message).toContain("No workspace selected")
  expect(h.selections[0]!.options.some((option) => option.value === "import")).toBe(false)
  expect(h.server.modelCalls).toBe(0)
  expect(h.forbidden).toEqual([])
  expect(await fs.exists(h.server.catalogPath)).toBe(false)
})

test("creating a saved definition keeps the displayed ordinary session unbound", async () => {
  const h = await setup()
  h.answers.push("create", "done", undefined)
  h.names.push("saved-only")
  await h.run()
  const state = await h.server.rpc.state({ sessionID: "ses_a" })
  expect(state.workspaces.map((workspace) => workspace.name)).toEqual(["saved-only"])
  expect(state.binding).toBeNull()
  expect(state.canAttach).toBe(true)
  expect(h.server.bindingCount()).toBe(0)
  expect(h.created).toEqual([])
  expect(h.alerts).toEqual([])
  expect(h.server.modelCalls).toBe(0)
})

test("an explicit choice attaches only the existing empty displayed session", async () => {
  const h = await setup()
  const workspace = (await h.server.seed()).workspaces[0]!
  h.answers.push("switch", workspace.id, "here", undefined)
  await h.run()
  expect((await h.server.rpc.selection({ sessionID: "ses_a" })).workspace?.id).toBe(workspace.id)
  expect((await h.server.rpc.selection({ sessionID: "ses_b" })).workspace).toBeNull()
  expect(h.created).toEqual([])
  expect(h.navigations).toEqual([])
  expect(h.alerts).toEqual([])
  expect(h.forbidden).toEqual([])
})

test("home activation creates/binds a real empty session and waits for confirmation before navigation", async () => {
  const h = await setup({ type: "home" })
  const workspace = (await h.server.seed()).workspaces[0]!
  const committed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  h.holdAttach(async () => { committed.resolve(); await release.promise })
  h.answers.push("switch", workspace.id, "new")
  const running = h.run()
  try {
    await committed.promise
    expect(h.created).toHaveLength(1)
    expect(h.navigations).toEqual([])
    expect((await h.server.rpc.selection({ sessionID: h.created[0]!.id })).workspace?.id).toBe(workspace.id)
  } finally { release.resolve(); await running }
  expect(h.navigations).toEqual([{ type: "session", sessionID: h.created[0]!.id }])
  expect(h.calls.filter((call) => call.method === "state")[0]!.input).toEqual({})
  expect(h.server.modelCalls).toBe(0)
  expect(h.forbidden).toEqual([])
  expect(h.alerts).toEqual([])
})

test("a started conversation only offers a new workspace session and retains its original binding", async () => {
  const h = await setup()
  const alpha = (await h.server.seed("alpha")).workspaces[0]!
  const beta = (await h.server.seed("beta")).workspaces.find((workspace) => workspace.name === "beta")!
  await h.server.change({ kind: "attach", workspaceID: alpha.id }, "ses_a")
  await h.server.context(h.server.request())
  h.answers.push("switch", beta.id, (options) => {
    expect(options.options.map((option) => option.value)).toEqual(["new"])
    return "new"
  })
  await h.run()
  expect((await h.server.rpc.selection({ sessionID: "ses_a" })).workspace?.id).toBe(alpha.id)
  expect((await h.server.rpc.selection({ sessionID: h.created[0]!.id })).workspace?.id).toBe(beta.id)
  expect(h.server.bindingCount()).toBe(2)
  expect(h.alerts).toEqual([])
})

test("detaching after work starts opens an ordinary session without rewriting existing history/bindings", async () => {
  const h = await setup()
  const workspace = (await h.server.seed()).workspaces[0]!
  await h.server.change({ kind: "attach", workspaceID: workspace.id }, "ses_a")
  await h.server.context(h.server.request())
  h.answers.push("detach")
  await h.run()
  expect(h.created).toHaveLength(1)
  expect(h.calls.filter((call) => call.method === "change")).toEqual([])
  expect((await h.server.rpc.selection({ sessionID: "ses_a" })).workspace?.id).toBe(workspace.id)
  expect((await h.server.rpc.selection({ sessionID: h.created[0]!.id })).workspace).toBeNull()
  expect(h.server.bindingCount()).toBe(1)
  expect(h.alerts).toEqual([])
})

test("navigation cancels a pending menu choice before it can mutate another session", async () => {
  const h = await setup()
  const entered = Promise.withResolvers<void>()
  const selected = Promise.withResolvers<string | undefined>()
  h.answers.push(() => { entered.resolve(); return selected.promise })
  const running = h.run()
  await entered.promise
  expect(h.selections).toHaveLength(1)
  h.route({ type: "session", sessionID: "ses_b" })
  selected.resolve("switch")
  await running
  expect(h.calls.filter((call) => call.method === "change")).toEqual([])
  expect(h.created).toEqual([])
  expect(await fs.exists(h.server.catalogPath)).toBe(false)
})

test("uncached session metadata never falls back to the launch Location, and unload aborts outstanding RPC options", async () => {
  const h = await setup()
  h.cached(false)
  await h.run()
  expect(h.calls).toEqual([])
  expect(h.alerts[0]!.message).toContain("metadata is loading")
  h.cached(true)
  h.answers.push(undefined)
  await h.run()
  h.unload()
  expect(h.unregistered).toBe(1)
  expect(h.calls.every((call) => call.options.signal.aborted)).toBe(true)
})
