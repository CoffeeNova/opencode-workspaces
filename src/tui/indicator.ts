import type { Context, SlotMap } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createComponent, createEffect, createSignal, onCleanup, Show } from "solid-js"
import { INDICATOR_TIMING } from "../shared/limits.ts"
import { WorkspaceRPC } from "../shared/rpc-contract.ts"
import type { Selection } from "../shared/schemas.ts"

export function label(name: string, columns: number, blocked = false) {
  const mark = blocked ? "!" : ""
  if (Bun.stringWidth(`[ws:${name}${mark}]`) <= columns) return `[ws:${name}${mark}]`
  let prefix = ""
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    name,
  )) {
    if (Bun.stringWidth(`[ws:${prefix}${segment}…${mark}]`) > columns) break
    prefix += segment
  }
  return `[ws:${prefix}…${mark}]`
}

export function registerWorkspaceIndicator(context: Context) {
  const rpc = context.client.rpc(WorkspaceRPC)
  const refreshers = new Set<() => void>()
  const knownActive = new Set<string>()
  const unregister = context.ui.slot({
    append: "prompt.footer.status",
    render: (props: SlotMap["prompt.footer.status"]) => {
      const [selection, setSelection] = createSignal<Selection>()
      const [unavailable, setUnavailable] = createSignal(false)
      const [columns, setColumns] = createSignal(context.renderer.width)
      const budget = () =>
        Math.min(
          INDICATOR_TIMING.maxColumns,
          Math.max(INDICATOR_TIMING.minColumns, Math.floor(columns() / 3)),
        )
      const resize = () => setColumns(context.renderer.width)
      context.renderer.on(CliRenderEvents.RESIZE, resize)
      onCleanup(() => context.renderer.off(CliRenderEvents.RESIZE, resize))

      createEffect(() => {
        const route = context.ui.router.current()
        const sessionID = props.sessionID
        const location = sessionID ? context.data.session.get(sessionID)?.location : undefined
        const visible = route.type === "session" && route.sessionID === sessionID
        setSelection(undefined)
        setUnavailable(false)
        if (!visible || !sessionID || !location?.directory) return
        const lifetime = new AbortController()
        const key = `${location.directory}\0${sessionID}`
        let active = knownActive.has(key)
        setUnavailable(active)
        let timer: ReturnType<typeof setTimeout> | undefined
        let busy = false
        let queued = false
        let catalogID: string | undefined
        let retryMs: number = INDICATOR_TIMING.retryMs
        const refresh = async () => {
          if (lifetime.signal.aborted) return
          if (busy) {
            queued = true
            return
          }
          clearTimeout(timer)
          busy = true
          try {
            const result = await rpc.selection(
              { sessionID },
              {
                location,
                signal: AbortSignal.any([
                  lifetime.signal,
                  AbortSignal.timeout(INDICATOR_TIMING.requestTimeoutMs),
                ]),
              },
            )
            if (lifetime.signal.aborted) return
            catalogID = result.catalogID ?? undefined
            active = result.workspace !== null
            if (active) knownActive.add(key)
            else knownActive.delete(key)
            setSelection(result)
            setUnavailable(false)
            retryMs = INDICATOR_TIMING.retryMs
          } catch {
            if (lifetime.signal.aborted) return
            setSelection(undefined) // Never present an old selection as current.
            active = knownActive.has(key)
            setUnavailable(active)
            retryMs = Math.min(retryMs * 2, INDICATOR_TIMING.maxRetryMs)
          } finally {
            busy = false
            if (!lifetime.signal.aborted && (active || queued)) {
              timer = setTimeout(
                () => {
                  void refresh()
                },
                queued ? 0 : retryMs,
              )
              queued = false
            }
          }
        }
        const requestRefresh = () => {
          void refresh()
        }
        const unsubscribe = rpc.events.on("changed", (event) => {
          if (
            event.location.directory !== location.directory ||
            (catalogID && event.data.catalogID !== catalogID) ||
            (event.data.sessionID && event.data.sessionID !== sessionID)
          )
            return
          if (active || event.data.sessionID) requestRefresh()
        })
        const reconnect = context.data.on("server.connected", requestRefresh)
        const deleted = context.data.on("session.deleted", (event) => {
          if (event.data.sessionID !== sessionID) return
          lifetime.abort()
          clearTimeout(timer)
          knownActive.delete(key)
          setSelection(undefined)
          setUnavailable(false)
        })
        refreshers.add(requestRefresh)
        requestRefresh()
        onCleanup(() => {
          lifetime.abort()
          clearTimeout(timer)
          unsubscribe()
          reconnect()
          deleted()
          refreshers.delete(requestRefresh)
        })
      })
      // The documented automatic JSX runtime lets this one text contribution
      // share the host renderer without a separate Babel/JSX build pipeline.
      return createComponent(Show, {
        keyed: true,
        get when() {
          return unavailable() || !!selection()?.workspace
        },
        get children() {
          return jsx("text", {
            get content() {
              if (unavailable()) return label("unavailable", budget())
              const current = selection()
              return current?.workspace
                ? label(current.workspace.name, budget(), current.instructions === "blocked")
                : ""
            },
            get fg() {
              return unavailable() || selection()?.instructions === "blocked"
                ? context.theme.text.feedback.warning.base
                : context.theme.text.muted
            },
            get maxWidth() {
              return budget()
            },
            wrapMode: "none",
            truncate: true,
            flexShrink: 0,
          })
        },
      })
    },
  })
  return {
    refresh() {
      for (const refresh of refreshers) refresh()
    },
    dispose() {
      unregister()
      knownActive.clear()
    },
  }
}
