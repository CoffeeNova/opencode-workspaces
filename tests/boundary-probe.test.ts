import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { boundaryGate } from "./fixtures/phase-zero-plugin/boundary.ts"
import { InheritanceMarker } from "./fixtures/phase-zero-plugin/rpc.ts"
import { randomUUID } from "node:crypto"

test("boundary probe advances only after every affected session is idle", async () => {
  const checked: string[] = []
  const saved: number[] = []
  const gate = boundaryGate({ epoch: 0, waitIdle: (id) => Effect.sync(() => { checked.push(id); return id !== "busy" }), save: (epoch) => Effect.sync(() => { saved.push(epoch) }) })
  expect(await Effect.runPromise(gate.advance(["idle", "busy"], 0))).toEqual({ type: "busy" })
  expect(checked).toEqual(["idle", "busy"])
  expect(saved).toEqual([])
  expect(await Effect.runPromise(gate.advance(["idle"], 0))).toEqual({ type: "advanced", epoch: 1 })
  expect(saved).toEqual([1])
})

test("stale boundary revisions do not wait or commit", async () => {
  const gate = boundaryGate({ epoch: 3, waitIdle: () => Effect.die("unexpected wait"), save: () => Effect.die("unexpected commit") })
  expect(await Effect.runPromise(gate.advance(["session"], 2))).toEqual({ type: "conflict", epoch: 3 })
})

test("context capture and management commit share one serialization boundary", async () => {
  const checking = Deferred.makeUnsafe<void>()
  const idle = Deferred.makeUnsafe<boolean>()
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.gen(function* () {
    yield* Deferred.succeed(checking, undefined)
    return yield* Deferred.await(idle)
  }), save: () => Effect.void })
  const mutation = Effect.runFork(gate.advance(["session"], 0))
  await Effect.runPromise(Deferred.await(checking))
  const context = Effect.runFork(gate.capture("session"))
  await Effect.runPromise(Deferred.succeed(idle, true))
  expect(await Effect.runPromise(Fiber.join(mutation))).toEqual({ type: "advanced", epoch: 1 })
  expect(await Effect.runPromise(Fiber.join(context))).toBe(1)
})

test("cancelling a management idle check releases the gate without a commit", async () => {
  const checking = Deferred.makeUnsafe<void>()
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.gen(function* () {
    yield* Deferred.succeed(checking, undefined)
    return yield* Effect.never
  }), save: () => Effect.die("cancelled operation must not save") })
  const mutation = Effect.runFork(gate.advance(["session"], 0))
  await Effect.runPromise(Deferred.await(checking))
  await Effect.runPromise(Fiber.interrupt(mutation))
  expect(await Effect.runPromise(gate.capture("session"))).toBe(0)
})

test("a native executor's permit rejects management while held", async () => {
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.die("must reject without an idle check"), save: () => Effect.void })
  await Effect.runPromise(gate.capture("session"))
  const started = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const running = Effect.runFork(gate.execute("session", Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(release)
  })))
  await Effect.runPromise(Deferred.await(started))
  try {
    expect(await Effect.runPromise(gate.advance(["session"], 0))).toEqual({ type: "busy" })
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(running))
  }
})

test("failed executors release their permits without relying on after hooks", async () => {
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.succeed(true), save: () => Effect.void })
  await Effect.runPromise(gate.capture("session"))
  await expect(Effect.runPromise(gate.execute("session", Effect.fail(new Error("native failure"))))).rejects.toThrow("native failure")
  expect(await Effect.runPromise(gate.advance(["session"], 0))).toEqual({ type: "advanced", epoch: 1 })
})

test("interrupted executors release permits and do not require completion events", async () => {
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.succeed(true), save: () => Effect.void })
  await Effect.runPromise(gate.capture("session"))
  const started = Deferred.makeUnsafe<void>()
  const running = Effect.runFork(gate.execute("session", Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Effect.never
  })))
  await Effect.runPromise(Deferred.await(started))
  await Effect.runPromise(Fiber.interrupt(running))
  expect(await Effect.runPromise(gate.advance(["session"], 0))).toEqual({ type: "advanced", epoch: 1 })
})

test("stale or missing snapshots fail before the executor's side effects", async () => {
  let mutations = 0
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.succeed(true), save: () => Effect.void })
  const write = Effect.sync(() => { mutations++ })
  await expect(Effect.runPromise(gate.execute("session", write))).rejects.toThrow("PROBE_STALE_SNAPSHOT")
  await Effect.runPromise(gate.capture("session"))
  await Effect.runPromise(gate.advance(["session"], 0))
  await expect(Effect.runPromise(gate.execute("session", write))).rejects.toThrow("PROBE_STALE_SNAPSHOT")
  expect(mutations).toBe(0)
  await Effect.runPromise(gate.capture("session"))
  await Effect.runPromise(gate.execute("session", write))
  expect(mutations).toBe(1)
})

test("failed probe persistence leaves the epoch unchanged and releases the gate", async () => {
  const gate = boundaryGate({ epoch: 0, waitIdle: () => Effect.succeed(true), save: () => Effect.fail(new Error("save failed")) })
  await expect(Effect.runPromise(gate.advance(["session"], 0))).rejects.toThrow("save failed")
  expect(gate.status()).toEqual({ epoch: 0, disposed: false })
  expect(await Effect.runPromise(gate.capture("session"))).toBe(0)
  gate.dispose()
  await expect(Effect.runPromise(gate.execute("session", Effect.void))).rejects.toThrow("PROBE_UNLOADED")
})

test("inheritance markers reject malformed or unrecognized fields", () => {
  const valid = { catalogID: randomUUID(), token: randomUUID() }
  expect(InheritanceMarker.safeParse(valid).success).toBe(true)
  expect(InheritanceMarker.safeParse({ token: "forged" }).success).toBe(false)
  expect(InheritanceMarker.safeParse({ ...valid, workspaceID: "untrusted" }).success).toBe(false)
})
