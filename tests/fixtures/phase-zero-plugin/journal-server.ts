import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect, type Scope } from "effect"
import * as fs from "node:fs/promises"
import path from "node:path"
import { bindingJournal, JournalError, JOURNAL_METADATA_KEY, readMarker, sameMarker, type JournalHost, type Stage } from "./binding-journal.ts"
import { JournalProbe } from "./journal-rpc.ts"
import { journalStore } from "./journal-store.ts"
import { journalPauses } from "./journal-pause.ts"

const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)

export function registerJournalProbe(ctx: Plugin.Context) {
  return Effect.gen(function* () {
    const fixture = ctx.options.fixtureDirectory
    if (typeof fixture !== "string" || !path.basename(fixture).startsWith("workspace-phase-zero-")) return yield* Effect.die(new Error("Journal probe requires an isolated fixture"))
    const fixtureDirectory = yield* Effect.promise(() => fs.realpath(fixture))
    const canonical = yield* Effect.promise(() => fs.realpath(ctx.location.directory))
    const relative = path.relative(fixtureDirectory, canonical)
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return yield* Effect.die(new Error("Journal probe Location is outside its fixture"))
    const runtime = yield* Effect.context<Scope.Scope>()
    const run = Effect.runPromiseWith(runtime)
    const store = yield* Effect.sync(() => journalStore(path.join(fixtureDirectory, "binding-journal.sqlite")))
    yield* Effect.addFinalizer(() => Effect.sync(store.close))
    async function get(sessionID: string, signal: AbortSignal) {
      const session = await run(ctx.session.get({ sessionID: Session.ID.make(sessionID) }), { signal })
      const directory = await fs.realpath(session.location.directory)
      if (key(directory) !== key(canonical)) throw new JournalError("LOCATION_MISMATCH", "The native session belongs to another Location")
      return session
    }
    const pauses = journalPauses()
    type Pause = ReturnType<typeof pauses.arm>
    const host = (pause?: Pause): JournalHost => ({
      async readSession(sessionID, signal) {
        const session = await get(sessionID, signal)
        return {
          id: session.id, marker: session.metadata?.[JOURNAL_METADATA_KEY],
          ...(session.parentID ? { parentID: session.parentID } : {}),
          ...(session.fork ? { forkSessionID: session.fork.sessionID } : {}),
        }
      },
      async publish(sessionID, before, after, signal) {
        const session = await get(sessionID, signal)
        if (!sameMarker(readMarker(session.metadata?.[JOURNAL_METADATA_KEY]), before)) return "not-applied"
        // COOPERATIVE-ONLY PROBE. This read/merge/write is NOT a native CAS and
        // cannot preserve arbitrary competing metadata writers. Never promote
        // it to production as an atomic or fully instruction-safe adapter.
        await pause?.at("metadata-read", signal)
        await run(ctx.session.update({ sessionID: session.id, metadata: { ...session.metadata, [JOURNAL_METADATA_KEY]: after } }), { signal })
        return "applied"
      },
    })
    const service = (interrupt?: Stage, pause?: Pause, signal?: AbortSignal) => bindingJournal(store, host(pause), async (stage) => {
      if (stage === interrupt) throw new JournalError("PROBE_INTERRUPTED", `Injected interruption after ${stage}`)
      if (signal) await pause?.at(stage, signal)
    })
    function task<T, E>(action: (signal: AbortSignal) => Promise<T>, error: (type: "journal_error", message: string, data: { code: string; message: string }) => E) {
      return Effect.tryPromise({ try: action, catch: (cause) => cause }).pipe(Effect.catch((cause) => {
        if (!(cause instanceof JournalError)) return Effect.die(cause)
        return Effect.fail(error("journal_error", cause.message, { code: cause.code, message: cause.message }))
      }))
    }
    yield* ctx.rpc.register(JournalProbe, {
      status: (_input, call) => task(async () => service().status(), call.error),
      change: (input, call) => task(async (signal) => {
        const { interruptAfter, pauseAfter, ...request } = input
        const pause = pauseAfter ? pauses.arm(request.requestID, pauseAfter) : undefined
        try { return await service(interruptAfter, pause, signal).change(request, signal) }
        finally { pause?.dispose() }
      }, call.error),
      recover: (input, call) => task((signal) => service().recover(input.requestID, signal), call.error),
      resolve: (input, call) => task((signal) => service().resolve(input.sessionID, signal), call.error),
      paused: (_input, call) => task(async () => pauses.status(), call.error),
      release: (input, call) => task(async () => { pauses.release(input.requestID); return {} }, call.error),
    }).pipe(Effect.orDie)
  })
}
