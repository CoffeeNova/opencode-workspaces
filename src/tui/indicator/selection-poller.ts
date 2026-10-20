import type { Context } from "@opencode/plugin/tui/context"
import { INDICATOR_TIMING } from "../../shared/limits.ts"
import type { Selection } from "../../shared/schemas.ts"
import type { WorkspaceClient } from "../menu/session.ts"

export type SelectionWatch = {
  rpc: WorkspaceClient
  context: Context
  sessionID: string
  location: NonNullable<Context["location"]>
  // `directory\0sessionID` keys last seen with a workspace, shared by every render.
  knownActive: Set<string>
  onSelection(selection: Selection | undefined): void
  onUnavailable(unavailable: boolean): void
  refreshers: Set<() => void>
}

// Keeps one displayed session's selection current; the returned function stops it.
export function watchSelection(options: SelectionWatch): () => void {
  return new SelectionPoller(options).start()
}

// Timing rules:
// - One request at a time. A refresh asked for mid-request is queued and runs
//   immediately after it.
// - Each request times out after `requestTimeoutMs`.
// - Polling continues only while a workspace is active: every `retryMs`, which
//   starts at the base interval and doubles after each failure up to `maxRetryMs`.
class SelectionPoller {
  private readonly lifetime = new AbortController()
  private readonly key: string
  private active: boolean
  private catalogID: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private busy = false
  private queued = false
  private retryMs: number = INDICATOR_TIMING.retryMs

  constructor(private readonly options: SelectionWatch) {
    this.key = `${options.location.directory}\0${options.sessionID}`
    this.active = options.knownActive.has(this.key)
    options.onUnavailable(this.active)
  }

  start(): () => void {
    const { rpc, context, sessionID, location, refreshers } = this.options
    const unsubscribe = rpc.events.on("changed", (event) => {
      if (event.location.directory !== location.directory) return
      if (this.catalogID && event.data.catalogID !== this.catalogID) return
      if (event.data.sessionID && event.data.sessionID !== sessionID) return
      if (this.active || event.data.sessionID) this.request()
    })
    const reconnect = context.data.on("server.connected", this.request)
    const deleted = context.data.on("session.deleted", (event) => {
      if (event.data.sessionID !== sessionID) return
      this.forget()
    })
    refreshers.add(this.request)
    this.request()
    return () => {
      this.stop()
      unsubscribe()
      reconnect()
      deleted()
      refreshers.delete(this.request)
    }
  }

  private readonly request = () => {
    void this.refresh()
  }

  private async refresh() {
    if (this.lifetime.signal.aborted) return
    if (this.busy) {
      this.queued = true
      return
    }
    clearTimeout(this.timer)
    this.busy = true
    try {
      const result = await this.fetchSelection()
      if (this.lifetime.signal.aborted) return
      this.accept(result)
    } catch {
      if (this.lifetime.signal.aborted) return
      this.fail()
    } finally {
      this.busy = false
      this.scheduleNext()
    }
  }

  private fetchSelection() {
    const { rpc, sessionID, location } = this.options
    const timeout = AbortSignal.timeout(INDICATOR_TIMING.requestTimeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, timeout])
    return rpc.selection({ sessionID }, { location, signal })
  }

  private accept(result: Selection) {
    const { knownActive } = this.options
    this.catalogID = result.catalogID ?? undefined
    this.active = result.workspace !== null
    if (this.active) knownActive.add(this.key)
    else knownActive.delete(this.key)
    this.options.onSelection(result)
    this.options.onUnavailable(false)
    this.retryMs = INDICATOR_TIMING.retryMs
  }

  private fail() {
    this.options.onSelection(undefined) // Never present an old selection as current.
    this.active = this.options.knownActive.has(this.key)
    this.options.onUnavailable(this.active)
    this.retryMs = Math.min(this.retryMs * 2, INDICATOR_TIMING.maxRetryMs)
  }

  // A queued refresh runs at once; otherwise poll again only while active.
  private scheduleNext() {
    if (this.lifetime.signal.aborted) return
    if (!this.active && !this.queued) return
    const delay = this.queued ? 0 : this.retryMs
    this.timer = setTimeout(this.request, delay)
    this.queued = false
  }

  private stop() {
    this.lifetime.abort()
    clearTimeout(this.timer)
  }

  // The session was deleted: stop, drop its key, and hide the indicator.
  private forget() {
    this.stop()
    this.options.knownActive.delete(this.key)
    this.options.onSelection(undefined)
    this.options.onUnavailable(false)
  }
}
