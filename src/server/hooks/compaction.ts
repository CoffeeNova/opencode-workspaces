import type { ServerRuntime } from "../runtime.ts"

export async function registerCompactionHook(runtime: ServerRuntime) {
  await runtime.ctx.session.hook("compaction", (event) => {
    // Synchronous, before any await: this request now blocks attachment.
    runtime.admission.markStarted(event.sessionID)
    runtime.instructions.invalidate(event.sessionID)
  })
}
