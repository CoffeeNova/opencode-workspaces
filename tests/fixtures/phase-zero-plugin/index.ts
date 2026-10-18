import { Plugin } from "@opencode/plugin"
import { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Session } from "@opencode/schema/session"
import { Effect, Option } from "effect"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { BoundaryProbe, CapabilityProbe, INHERITANCE_METADATA_KEY, InheritanceMarker, TuiProbe } from "./rpc.ts"
import { boundaryGate } from "./boundary.ts"
import { registerJournalProbe } from "./journal-server.ts"
import { registerInstructionProbe } from "./instruction-server.ts"

const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)

const promiseProbe = Plugin.define({
  id: "workspace-manager.capability-probe",
  async setup(ctx) {
    const fixture = ctx.options.fixtureDirectory
    if (typeof fixture !== "string" || !path.basename(fixture).startsWith("workspace-phase-zero-")) {
      throw new Error("The capability probe requires an isolated phase-zero fixture")
    }
    const canonical = await fs.realpath(ctx.location.directory)
    const relative = path.relative(await fs.realpath(fixture), canonical)
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("The capability probe must run inside its disposable fixture")
    }
    const trace = path.join(fixture, "observations.jsonl")
    const instanceID = randomUUID()
    // Only synthetic fixture data is captured. Nothing is written to user storage.
    let writes = Promise.resolve()
    const record = (kind: string, data: unknown) => {
      writes = writes.then(() => fs.appendFile(trace, `${JSON.stringify({ kind, instanceID, data })}\n`))
      return writes
    }
    await record("setup", { version: ctx.app.version, directory: canonical })
    await ctx.tool.transform((editor) => {
      for (const name of ["read", "edit", "write", "patch", "shell"]) {
        editor.update(name, (tool) => {
          tool.options = {
            codemode: false,
            ...(tool.options?.namespace ? { namespace: tool.options.namespace } : {}),
            ...(tool.options?.permission ? { permission: tool.options.permission } : {}),
          }
        })
      }
    })
    await ctx.rpc.register(CapabilityProbe, {
      inspect: async (input, call) => {
        call.signal.throwIfAborted()
        const session = input.sessionID === undefined ? undefined : await ctx.session.get({ sessionID: input.sessionID })
        if (session && key(await fs.realpath(session.location.directory)) !== key(canonical)) {
          return call.error("location_mismatch", "The session belongs to another Location", { sessionID: session.id })
        }
        if (session) await ctx.permission.assert({
          sessionID: session.id,
          action: "workspace_probe_metadata",
          resources: [canonical],
          save: [],
        })
        const rawMarker = session?.metadata?.[INHERITANCE_METADATA_KEY]
        const marker = InheritanceMarker.safeParse(rawMarker)
        await record("rpc.inspect", { sessionID: session?.id })
        return {
          instanceID,
          runtimeVersion: ctx.app.version,
          directory: canonical,
          ...(session ? { session: {
            id: session.id,
            ...(session.parentID ? { parentID: session.parentID } : {}),
            ...(session.fork ? { forkSessionID: session.fork.sessionID } : {}),
            inheritance: rawMarker === undefined ? { status: "absent" as const }
              : marker.success ? { status: "valid" as const, marker: marker.data }
              : { status: "invalid" as const },
          } } : {}),
        }
      },
      waitIdle: async (input, call) => {
        const session = await ctx.session.get({ sessionID: input.sessionID })
        if (key(await fs.realpath(session.location.directory)) !== key(canonical)) {
          return call.error("location_mismatch", "The session belongs to another Location", { sessionID: session.id })
        }
        call.signal.throwIfAborted()
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(new Error("Idle wait deadline exceeded")), input.timeoutMs)
        const signal = AbortSignal.any([call.signal, deadline.signal])
        try {
          await ctx.session.wait({ sessionID: session.id }, { signal })
          await record("idle.wait", { sessionID: session.id, idle: true })
          return { idle: true }
        } catch (error) {
          call.signal.throwIfAborted()
          if (!deadline.signal.aborted) throw error
          await record("idle.wait", { sessionID: session.id, idle: false })
          return { idle: false }
        } finally {
          clearTimeout(timer)
        }
      },
    })
    let tuiEventCount = 0
    await ctx.rpc.register(TuiProbe, {
      record: async (input) => {
        if (tuiEventCount >= 200) throw new Error("Disposable TUI telemetry limit exceeded")
        tuiEventCount++ // Reserve synchronously, including writes still in flight.
        await record("tui.lifecycle", input)
        return {}
      },
    })
    await ctx.session.hook("title", (event) => { event.result = "Phase-zero fixture" })
    await ctx.session.hook("retry", (event) => { event.decision = { retry: false } })
    await ctx.session.hook("http.request", (event) => {
      if (new URL(event.request.url).origin !== ctx.options.providerOrigin) {
        throw new Error("The capability probe refuses non-fixture model requests")
      }
    })
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "PHASE_ZERO_CONTEXT: disposable capability fixture, not workspace instructions." })
    })
    await registerInstructionProbe(ctx, fixture, record)
    await ctx.session.hook("context", (event) => record("context", event))
    await ctx.tool.hook("execute.before", async (event) => {
      await record("tool.before.1", event)
      const input = event.input as { path?: unknown; patchText?: unknown }
      if ((event.tool === "write" && typeof input.path === "string" && path.basename(input.path) === "blocked.txt")
        || (event.tool === "patch" && typeof input.patchText === "string" && input.patchText.includes("/blocked.txt"))) {
        throw new ToolError({ message: "PHASE_ZERO_BLOCKED: preflight rejected before mutation" })
      }
    })
    await ctx.tool.hook("execute.before", (event) => record("tool.before.2", event))
    await ctx.tool.hook("execute.after", (event) => record("tool.after", event))
    await ctx.permission.hook("evaluate", (event) => record("permission", event))
    const controller = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.created" || event.type.startsWith("session.execution.")) {
          await record("lifecycle", event)
        }
      }
    })()
    // The subscription is live-only; observation is not an atomic creation hook.
    void events.catch(() => {})
    return async () => {
      controller.abort()
      await events.catch(() => {})
      await record("cleanup", {})
    }
  },
})

// A single packaged server entrypoint. The public adapter owns the existing
// Promise registrations; the native Effect method keeps its cancellation scope.
export default EffectPlugin.define({
  id: promiseProbe.id,
  effect: (ctx) => Effect.gen(function* () {
    yield* fromPromise(promiseProbe).effect(ctx)
    const canonical = yield* Effect.promise(() => fs.realpath(ctx.location.directory))
    const storedEpoch = yield* ctx.storage.get("boundary.epoch")
    if (storedEpoch !== undefined && (typeof storedEpoch !== "number" || !Number.isSafeInteger(storedEpoch) || storedEpoch < 0)) {
      return yield* Effect.die(new Error("Invalid disposable boundary epoch"))
    }
    const boundary = boundaryGate({
      epoch: typeof storedEpoch === "number" ? storedEpoch : 0,
      save: (epoch) => ctx.storage.set("boundary.epoch", epoch),
      waitIdle: (sessionID) => ctx.session.wait({ sessionID: Session.ID.make(sessionID) }).pipe(
        Effect.timeoutOption(50), Effect.map(Option.isSome),
      ),
    })
    yield* Effect.addFinalizer(() => Effect.sync(boundary.dispose))
    yield* ctx.session.hook("context", (event) => boundary.capture(event.sessionID).pipe(Effect.map((epoch) => {
      event.system.push({ type: "text", text: `PHASE_ZERO_EPOCH: ${epoch}` })
    })))
    yield* ctx.tool.transform((editor) => {
      for (const name of ["read", "edit", "write", "patch", "shell"]) {
        editor.update(name, (tool) => {
          const original = tool.execute
          tool.execute = (input, context) => boundary.execute(context.sessionID, original(input, context))
        })
      }
    })
    yield* ctx.rpc.register(BoundaryProbe, {
      status: () => Effect.sync(boundary.status),
      advanceEpoch: (input, call) => Effect.gen(function* () {
        for (const sessionID of input.sessionIDs) {
          const session = yield* ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(Effect.orDie)
          const directory = yield* Effect.promise(() => fs.realpath(session.location.directory))
          if (key(directory) !== key(canonical)) {
            return yield* Effect.fail(call.error("location_mismatch", "The session belongs to another Location", { sessionID }))
          }
        }
        const result = yield* boundary.advance(input.sessionIDs, input.expectedEpoch).pipe(Effect.orDie)
        if (result.type === "busy") return yield* Effect.fail(call.error("session_busy", "Probe session is busy", {}))
        if (result.type === "conflict") return yield* Effect.fail(call.error("revision_conflict", "Stale probe revision", { epoch: result.epoch }))
        return { epoch: result.epoch }
      }),
      waitIdle: (input, call) => Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) }).pipe(Effect.orDie)
        const directory = yield* Effect.promise(() => fs.realpath(session.location.directory))
        if (key(directory) !== key(canonical)) {
          return yield* Effect.fail(call.error("location_mismatch", "The session belongs to another Location", { sessionID: session.id }))
        }
        const result = yield* ctx.session.wait({ sessionID: session.id }).pipe(Effect.timeoutOption(input.timeoutMs), Effect.orDie)
        return { idle: Option.isSome(result) }
      }),
    }).pipe(Effect.orDie)
    yield* registerJournalProbe(ctx)
  }),
})
