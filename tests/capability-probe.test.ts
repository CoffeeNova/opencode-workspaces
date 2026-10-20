import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/plugin"
import type { KeymapLayer, Route } from "@opencode/plugin/tui/context"
import Probe from "./fixtures/phase-zero-plugin/tui.ts"
import { isolatedEnvironment } from "./helpers/capability-fixture.ts"
import { TuiObservation } from "./fixtures/phase-zero-plugin/rpc.ts"
import type { Fake } from "./helpers/fake.ts"

async function harness(route: Route = { type: "home" }, cached = true) {
  const selected = Promise.withResolvers<string | undefined>()
  const result = Promise.withResolvers<{ runtimeVersion: string; directory: string; session?: { id: string } }>()
  const selections: unknown[] = []
  const alerts: { title: string; message: string }[] = []
  const calls: { input: unknown; options: { location: unknown; signal: AbortSignal } }[] = []
  let layer: KeymapLayer | undefined
  let cleared = 0
  let forbiddenCalls = 0
  let currentRoute = route
  let directory = "D:/session-location"
  let unsubscribed = 0
  const telemetry: unknown[] = []
  const context = {
    location: { directory: "C:/launch" },
    data: {
      location: { default: () => ({ directory: "C:/default" }) },
      session: { get: () => cached ? { location: { directory } } : undefined },
      listen: () => () => { unsubscribed++ },
    },
    client: new Proxy({
      rpc: () => ({ inspect: (input: unknown, options: { location: unknown; signal: AbortSignal }) => {
        calls.push({ input, options })
        return result.promise
      }, record: async (event: unknown) => { telemetry.push(event); return {} } }),
    }, { get(target, name) {
      if (name === "rpc") return target.rpc
      forbiddenCalls++
      throw new Error(`Administrative handlers cannot access client.${String(name)}`)
    } }),
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() }, commands: () => layer?.commands ?? [] },
    ui: {
      router: { current: () => currentRoute },
      dialog: {
        select: (options: unknown) => { selections.push(options); return selected.promise },
        alert: async (options: { title: string; message: string }) => { alerts.push(options) },
        clear: () => { cleared++ },
      },
    },
  } satisfies Fake<Context> as unknown as Context
  const cleanup = await Probe.setup(context)
  const command = layer?.commands?.[0]
  if (!command || typeof cleanup !== "function") throw new Error("Probe did not register a command/cleanup")
  return {
    command, cleanup, selected, result, selections, alerts, calls,
    telemetry, route: (value: Route) => { currentRoute = value }, directory: (value: string) => { directory = value },
    get unsubscribed() { return unsubscribed },
    get cleared() { return cleared }, get forbiddenCalls() { return forbiddenCalls },
  }
}

test("probe slash and palette share a direct unbound handler; home RPC has no fabricated session", async () => {
  const h = await harness()
  expect(h.command.id).toBe("workspace-manager.capability-probe.open")
  expect(h.command.slash).toEqual({ name: "workspace-probe" })
  expect(h.command.palette).toBe(true)
  expect(h.command.bind).toBeUndefined()
  h.selected.resolve("inspect")
  h.result.resolve({ runtimeVersion: "2.0.32", directory: "C:/launch" })
  await h.command.run()
  expect(h.calls).toHaveLength(1)
  expect(h.calls[0]?.input).toEqual({})
  expect(h.calls[0]?.options.location).toEqual({ directory: "C:/launch" })
  expect(h.alerts[0]?.message).toContain("none (home)")
  expect(h.forbiddenCalls).toBe(0)
  await h.cleanup()
})

test("probe targets the displayed session's Location, not the launch directory", async () => {
  const h = await harness({ type: "session", sessionID: "ses_displayed" })
  h.selected.resolve("inspect")
  h.result.resolve({ runtimeVersion: "2.0.32", directory: "D:/session-location", session: { id: "ses_displayed" } })
  await h.command.run()
  expect(h.calls[0]?.input).toEqual({ sessionID: "ses_displayed" })
  expect(h.calls[0]?.options.location).toEqual({ directory: "D:/session-location" })
  expect(h.forbiddenCalls).toBe(0)
  await h.cleanup()
})

test("an uncached session does not silently use a different Location", async () => {
  const h = await harness({ type: "session", sessionID: "ses_loading" }, false)
  await h.command.run()
  expect(h.calls).toEqual([])
  expect(h.selections).toEqual([])
  expect(h.alerts[0]?.message).toContain("metadata is loading")
  await h.cleanup()
})

test("Escape/dialog replacement cancels without inspection or generation", async () => {
  const h = await harness()
  h.selected.resolve(undefined)
  await h.command.run()
  expect(h.calls).toEqual([])
  expect(h.alerts).toEqual([])
  expect(h.forbiddenCalls).toBe(0)
  await h.cleanup()
})

test("concurrent submissions open only one probe flow", async () => {
  const h = await harness()
  const first = h.command.run()
  const second = h.command.run()
  expect(h.selections).toHaveLength(1)
  h.selected.resolve("inspect")
  h.result.resolve({ runtimeVersion: "2.0.32", directory: "C:/launch" })
  await Promise.all([first, second])
  expect(h.calls).toHaveLength(1)
  await h.cleanup()
})

test("unload cancels pending RPC and ignores its late reply", async () => {
  const h = await harness()
  const pending = h.command.run()
  h.selected.resolve("inspect")
  await Promise.resolve()
  expect(h.calls).toHaveLength(1)
  await h.cleanup()
  expect(h.calls[0]?.options.signal.aborted).toBe(true)
  expect(h.cleared).toBe(1)
  expect(h.unsubscribed).toBe(1)
  h.result.resolve({ runtimeVersion: "2.0.32", directory: "C:/launch" })
  await pending
  expect(h.alerts).toEqual([])
  await h.command.run()
  expect(h.selections).toHaveLength(1)
})

test("a session change while a menu is open cancels the stale action", async () => {
  const h = await harness({ type: "session", sessionID: "ses_a" })
  const pending = h.command.run()
  h.route({ type: "session", sessionID: "ses_b" })
  h.selected.resolve("inspect")
  await pending
  expect(h.calls).toEqual([])
  expect(h.alerts).toEqual([])
  await h.cleanup()
})

test("late RPC results and errors do not open a dialog in another session", async () => {
  for (const error of [false, true]) {
    const h = await harness({ type: "session", sessionID: "ses_a" })
    const pending = h.command.run()
    h.selected.resolve("inspect")
    await Promise.resolve()
    expect(h.calls).toHaveLength(1)
    h.route({ type: "session", sessionID: "ses_b" })
    if (error) h.result.reject(new Error("Late fixture error"))
    else h.result.resolve({ runtimeVersion: "2.0.32", directory: "D:/session-location", session: { id: "ses_a" } })
    await pending
    expect(h.alerts).toEqual([])
    await h.cleanup()
  }
})

test("a moved session does not reuse the menu's old Location", async () => {
  const h = await harness({ type: "session", sessionID: "ses_a" })
  const pending = h.command.run()
  h.directory("E:/moved-location")
  h.selected.resolve("inspect")
  await pending
  expect(h.calls).toEqual([])
  expect(h.alerts).toEqual([])
  await h.cleanup()
})

test("declared RPC errors show the host's message", async () => {
  const h = await harness()
  const pending = h.command.run()
  h.selected.resolve("inspect")
  h.result.reject({ type: "location_mismatch", message: "Session moved; reopen the menu" })
  await pending
  expect(h.alerts).toEqual([{ title: "Workspace probe failed", message: "Session moved; reopen the menu" }])
  expect(h.forbiddenCalls).toBe(0)
  await h.cleanup()
})

test("failed TUI setup releases its manually owned event listener", async () => {
  for (const stage of ["layer", "rpc"]) {
    let unsubscribed = 0
    const context = {
      location: { directory: "C:/fixture" },
      client: { rpc: () => ({ record: async () => { throw new Error("Fixture RPC unavailable") } }) },
      keymap: { layer: () => { if (stage === "layer") throw new Error("Fixture layer unavailable") }, commands: () => [] },
      data: { listen: () => () => { unsubscribed++ } },
    } satisfies Fake<Context> as unknown as Context
    await expect(Probe.setup(context)).rejects.toThrow("unavailable")
    expect(unsubscribed).toBe(1)
  }
})

test("TUI diagnostic RPC accepts only bounded IDs and counters, never draft content", () => {
  const event = { instanceID: crypto.randomUUID(), event: "command", commandCopies: 1, sessionID: "ses_AbCd" }
  expect(TuiObservation.safeParse(event).success).toBe(true)
  expect(TuiObservation.safeParse({ ...event, sessionID: `ses_${"a".repeat(181)}` }).success).toBe(false)
  expect(TuiObservation.safeParse({ ...event, commandCopies: 21 }).success).toBe(false)
  expect(TuiObservation.safeParse({ ...event, draft: "must not enter telemetry" }).success).toBe(false)
})

test("capability child environment is isolated and does not inherit provider/config credentials", () => {
  const environment = isolatedEnvironment("C:/fixture")
  expect(environment.OPENCODE_CONFIG_DIR).toContain("fixture")
  expect(environment.OPENCODE_DB).toContain("fixture")
  expect(environment.XDG_STATE_HOME).toContain("fixture")
  expect(environment.ProgramData).toContain("fixture")
  expect(environment.OPENAI_API_KEY).toBeUndefined()
  expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
  expect(environment.OPENCODE_CONFIG).toBeUndefined()
  expect(environment.OPENCODE_PASSWORD).not.toBe(process.env.OPENCODE_PASSWORD)
})
