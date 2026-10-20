// Characterization of the footer indicator's selection polling, driven by fake timers.
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test"
import { Selection } from "../../src/shared/schemas.ts"
import { watchSelection } from "../../src/tui/indicator/selection-poller.ts"

type Watch = Parameters<typeof watchSelection>[0]
type Listener = (event: { data: Record<string, unknown>; location?: { directory: string } }) => void
type Request = { resolve(selection: Selection): void; reject(error: unknown): void }

const DIRECTORY = "/projects/app"
const SESSION = "ses_watched"
const KEY = `${DIRECTORY}\0${SESSION}`
const CATALOG = "11111111-1111-4111-8111-111111111111"
const WORKSPACE = "22222222-2222-4222-8222-222222222222"

// Poll timers are observed through setTimeout/clearTimeout; jest.getTimerCount() would also
// count the per-request AbortSignal.timeout timers.
let schedule: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>
let cancel: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>
beforeEach(() => {
  jest.useFakeTimers()
  schedule = spyOn(globalThis, "setTimeout")
  cancel = spyOn(globalThis, "clearTimeout")
})
afterEach(() => {
  schedule.mockRestore()
  cancel.mockRestore()
  jest.useRealTimers()
})

function selection(active: boolean): Selection {
  return Selection.parse({
    catalogID: CATALOG,
    revision: 1,
    workspace: active ? { id: WORKSPACE, name: "alpha", revision: 1, rootCount: 1 } : null,
    sealed: active,
    instructions: active ? "ready" : "not-loaded",
  })
}

// Lets pending promise continuations run without advancing fake time.
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function watch(knownActive: string[] = []) {
  const requests: Request[] = []
  const listeners = {
    changed: new Set<Listener>(),
    "server.connected": new Set<Listener>(),
    "session.deleted": new Set<Listener>(),
  }
  const selections: (Selection | undefined)[] = []
  const unavailable: boolean[] = []
  const known = new Set(knownActive)
  const refreshers = new Set<() => void>()
  const subscribe = (name: keyof typeof listeners, listener: Listener) => {
    listeners[name].add(listener)
    return () => {
      listeners[name].delete(listener)
    }
  }
  const rpc = {
    selection: () =>
      new Promise<Selection>((resolve, reject) => requests.push({ resolve, reject })),
    events: { on: (_name: "changed", listener: Listener) => subscribe("changed", listener) },
  }
  const context = {
    data: {
      on: (name: "server.connected" | "session.deleted", listener: Listener) =>
        subscribe(name, listener),
    },
  }
  const stop = watchSelection({
    rpc: rpc as unknown as Watch["rpc"],
    context: context as unknown as Watch["context"],
    sessionID: SESSION,
    location: { directory: DIRECTORY } as Watch["location"],
    knownActive: known,
    onSelection: (value) => selections.push(value),
    onUnavailable: (value) => unavailable.push(value),
    refreshers,
  })
  return { requests, listeners, selections, unavailable, known, refreshers, stop }
}

// The handle of the most recently scheduled poll timer.
function lastTimer() {
  return schedule.mock.results.at(-1)!.value
}

// Delays passed to setTimeout since the last call, in order.
function scheduledDelays() {
  const delays = schedule.mock.calls.map((call) => call[1])
  schedule.mockClear()
  return delays
}

test("a refresh requested while one is in flight is queued and runs at 0 ms afterwards", async () => {
  const watched = watch()
  expect(watched.requests).toHaveLength(1)
  for (const refresh of watched.refreshers) refresh()
  expect(watched.requests).toHaveLength(1)
  scheduledDelays()
  watched.requests[0]!.resolve(selection(false))
  await settle()
  expect(scheduledDelays()).toEqual([0])
  expect(watched.requests).toHaveLength(1)
  jest.advanceTimersByTime(0)
  expect(watched.requests).toHaveLength(2)
  watched.requests[1]!.resolve(selection(false))
  await settle()
  expect(scheduledDelays()).toEqual([])
  jest.advanceTimersByTime(60_000)
  expect(watched.requests).toHaveLength(2)
  watched.stop()
})

test("an active session backs off 2 s, 4 s, 8 s, then 10 s on failures and resets on success", async () => {
  const watched = watch()
  scheduledDelays()
  watched.requests[0]!.resolve(selection(true))
  await settle()
  expect(scheduledDelays()).toEqual([2000])
  const outcomes = [false, false, false, false, true, false] as const
  const expected = [4000, 8000, 10_000, 10_000, 2000, 4000]
  for (const [index, succeeds] of outcomes.entries()) {
    const delay = index === 0 ? 2000 : expected[index - 1]!
    jest.advanceTimersByTime(delay - 1)
    expect(watched.requests).toHaveLength(index + 1)
    jest.advanceTimersByTime(1)
    expect(watched.requests).toHaveLength(index + 2)
    const request = watched.requests[index + 1]!
    if (succeeds) request.resolve(selection(true))
    else request.reject(new Error("offline"))
    await settle()
    expect(scheduledDelays()).toEqual([expected[index]!])
  }
  watched.stop()
})

test("a passive session schedules no polling timer", async () => {
  const watched = watch()
  scheduledDelays()
  watched.requests[0]!.resolve(selection(false))
  await settle()
  expect(scheduledDelays()).toEqual([])
  jest.advanceTimersByTime(60_000)
  expect(watched.requests).toHaveLength(1)
  expect(watched.selections).toEqual([selection(false)])
  watched.stop()
})

test("unavailable is reported only for a session previously known to be active", async () => {
  const passive = watch()
  passive.requests[0]!.reject(new Error("offline"))
  await settle()
  expect(passive.unavailable).toEqual([false, false])
  expect(passive.selections).toEqual([undefined])
  expect(scheduledDelays()).toEqual([])
  passive.stop()

  const known = watch([KEY])
  expect(known.unavailable).toEqual([true])
  known.requests[0]!.reject(new Error("offline"))
  await settle()
  expect(known.unavailable).toEqual([true, true])
  expect(known.selections).toEqual([undefined])
  known.stop()

  const activated = watch()
  activated.requests[0]!.resolve(selection(true))
  await settle()
  expect(activated.known.has(KEY)).toBe(true)
  jest.advanceTimersByTime(2000)
  activated.requests[1]!.reject(new Error("offline"))
  await settle()
  expect(activated.unavailable).toEqual([false, false, true])
  expect(activated.selections).toEqual([selection(true), undefined])
  activated.stop()
})

test("session.deleted for the watched session stops polling and hides the indicator", async () => {
  const watched = watch()
  scheduledDelays()
  watched.requests[0]!.resolve(selection(true))
  await settle()
  const timer = lastTimer()
  expect(scheduledDelays()).toEqual([2000])
  cancel.mockClear()
  for (const listener of watched.listeners["session.deleted"]) {
    listener({ data: { sessionID: "ses_other" } })
  }
  expect(cancel).not.toHaveBeenCalled()
  for (const listener of watched.listeners["session.deleted"]) {
    listener({ data: { sessionID: SESSION } })
  }
  expect(cancel).toHaveBeenCalledWith(timer)
  expect(watched.known.has(KEY)).toBe(false)
  expect(watched.selections).toEqual([selection(true), undefined])
  expect(watched.unavailable).toEqual([false, false, false])
  // Listeners stay registered until cleanup, but no longer issue requests.
  for (const listener of watched.listeners["server.connected"]) listener({ data: {} })
  for (const refresh of watched.refreshers) refresh()
  jest.advanceTimersByTime(60_000)
  expect(watched.requests).toHaveLength(1)
  watched.stop()
  for (const listeners of Object.values(watched.listeners)) expect(listeners.size).toBe(0)
  expect(watched.refreshers.size).toBe(0)
})

test("the returned cleanup cancels the poll timer and unsubscribes every listener", async () => {
  const watched = watch()
  watched.requests[0]!.resolve(selection(true))
  await settle()
  const timer = lastTimer()
  expect(scheduledDelays()).toEqual([2000])
  cancel.mockClear()
  for (const listeners of Object.values(watched.listeners)) expect(listeners.size).toBe(1)
  expect(watched.refreshers.size).toBe(1)
  watched.stop()
  expect(cancel).toHaveBeenCalledWith(timer)
  for (const listeners of Object.values(watched.listeners)) expect(listeners.size).toBe(0)
  expect(watched.refreshers.size).toBe(0)
  jest.advanceTimersByTime(60_000)
  expect(watched.requests).toHaveLength(1)
})

test("a result arriving after cleanup is ignored and schedules nothing", async () => {
  const watched = watch()
  watched.stop()
  watched.requests[0]!.resolve(selection(true))
  await settle()
  expect(watched.selections).toEqual([])
  expect(watched.unavailable).toEqual([false])
  expect(scheduledDelays()).toEqual([])
  expect(watched.known.has(KEY)).toBe(false)
})
