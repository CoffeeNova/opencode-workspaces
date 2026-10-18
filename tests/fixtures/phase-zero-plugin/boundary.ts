import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, Option, Semaphore } from "effect"

// Throwaway protocol proof for one host/Location, not a registry implementation.
export function boundaryGate(input: {
  epoch: number
  waitIdle(sessionID: string): Effect.Effect<boolean, unknown>
  save(epoch: number): Effect.Effect<void, unknown>
}) {
  const gate = Semaphore.makeUnsafe(1)
  const snapshots = new Map<string, number>()
  let epoch = input.epoch
  let disposed = false
  type Result = { type: "advanced"; epoch: number } | { type: "busy" } | { type: "conflict"; epoch: number }
  return {
    status: () => ({ epoch, disposed }),
    capture: (sessionID: string) => gate.withPermit(Effect.sync(() => {
      if (disposed) throw new Error("PROBE_UNLOADED")
      snapshots.set(sessionID, epoch)
      return epoch
    })),
    execute: <A, E, R>(sessionID: string, operation: Effect.Effect<A, E, R>) => gate.withPermit(Effect.suspend((): Effect.Effect<A, E | ToolError, R> => {
      if (disposed) return Effect.fail(new ToolError({ message: "PROBE_UNLOADED" }))
      if (snapshots.get(sessionID) !== epoch) return Effect.fail(new ToolError({ message: "PROBE_STALE_SNAPSHOT" }))
      // A scoped permit surrounds the real executor, not execute.before/after.
      return operation
    })),
    advance: (sessionIDs: readonly string[], expectedEpoch: number): Effect.Effect<Result, unknown> => gate.withPermitsIfAvailable(1)(Effect.gen(function* () {
      if (disposed) return yield* Effect.die(new Error("PROBE_UNLOADED"))
      if (epoch !== expectedEpoch) return { type: "conflict", epoch } as const
      for (const sessionID of sessionIDs) {
        if (!(yield* input.waitIdle(sessionID))) return { type: "busy" } as const
      }
      const next = epoch + 1
      // Never leave memory behind a committed probe counter on cancellation.
      yield* Effect.gen(function* () {
        yield* input.save(next)
        epoch = next
      }).pipe(Effect.uninterruptible)
      return { type: "advanced", epoch } as const
    })).pipe(Effect.map((result) => Option.getOrElse(result, () => ({ type: "busy" as const })))),
    dispose: () => { disposed = true },
  }
}
