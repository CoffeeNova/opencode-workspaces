import { JournalError } from "./binding-journal.ts"

export type PauseStage = "prepared" | "metadata-read"

// Deterministic test scheduling only, not a publication lock or host primitive.
// One paused RPC at a time, scoped to that RPC's lifetime and cancellation.
export function journalPauses() {
  type Hold = { requestID: string; stage: PauseStage; entered: boolean; release: ReturnType<typeof Promise.withResolvers<void>> }
  let active: Hold | undefined
  return {
    status: () => ({ pause: active?.entered ? { requestID: active.requestID, stage: active.stage } : null }),
    release(requestID: string) {
      if (!active?.entered || active.requestID !== requestID) throw new JournalError("UNKNOWN_PAUSE", "No matching paused probe publication")
      active.release.resolve()
    },
    arm(requestID: string, stage: PauseStage) {
      if (active) throw new JournalError("PROBE_BUSY", "Another probe publication is already paused")
      const hold: Hold = { requestID, stage, entered: false, release: Promise.withResolvers<void>() }
      active = hold
      return {
        async at(actual: string, signal: AbortSignal) {
          signal.throwIfAborted()
          if (actual !== hold.stage) return
          hold.entered = true
          await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
            signal.addEventListener("abort", abort, { once: true })
            void hold.release.promise.then(() => { signal.removeEventListener("abort", abort); resolve() })
          })
          signal.throwIfAborted()
        },
        dispose() {
          if (active === hold) active = undefined
          hold.release.resolve()
        },
      }
    },
  }
}
