import type { Context, SlotMap } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { Selection } from "../domain.ts"
import { WorkspaceRPC } from "../rpc.ts"

function label(name: string, columns: number, blocked = false) {
  const mark = blocked ? "!" : ""
  if (Bun.stringWidth(`[ws:${name}${mark}]`) <= columns) return `[ws:${name}${mark}]`
  let prefix = ""
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)) {
    if (Bun.stringWidth(`[ws:${prefix}${segment}…${mark}]`) > columns) break
    prefix += segment
  }
  return `[ws:${prefix}…${mark}]`
}

export function registerWorkspaceIndicator(context: Context) {
  const rpc = context.client.rpc(WorkspaceRPC)
  const refreshers = new Set<() => void>()
  const unregister = context.ui.slot({
    append: "prompt.footer.status",
    render: (props: SlotMap["prompt.footer.status"]) => {
      const [selection, setSelection] = createSignal<Selection>()
      const [unavailable, setUnavailable] = createSignal(false)
      const [columns, setColumns] = createSignal(context.renderer.width)
      const budget = () => Math.min(28, Math.max(8, Math.floor(columns() / 3)))
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
        let timer: ReturnType<typeof setTimeout> | undefined
        let busy = false
        let queued = false
        let catalogID: string | undefined
        let retryMs = 2000
        async function refresh() {
          if (lifetime.signal.aborted) return
          if (busy) { queued = true; return }
          clearTimeout(timer)
          busy = true
          try {
            const result = await rpc.selection({ sessionID: sessionID! }, { location: location!, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]) })
            if (lifetime.signal.aborted) return
            catalogID = result.catalogID
            setSelection(result)
            setUnavailable(false)
            retryMs = 2000
          } catch {
            if (lifetime.signal.aborted) return
            setSelection(undefined) // Never present an old selection as current.
            setUnavailable(true)
            retryMs = Math.min(retryMs * 2, 10_000)
          } finally {
            busy = false
            if (!lifetime.signal.aborted) {
              timer = setTimeout(() => { void refresh() }, queued ? 0 : retryMs)
              queued = false
            }
          }
        }
        const requestRefresh = () => { void refresh() }
        const unsubscribe = rpc.events.on("changed", (event) => {
          if (event.location.directory !== location.directory || (catalogID && event.data.catalogID !== catalogID)
            || (event.data.sessionID && event.data.sessionID !== sessionID)) return
          requestRefresh()
        })
        refreshers.add(requestRefresh)
        requestRefresh()
        onCleanup(() => {
          lifetime.abort()
          clearTimeout(timer)
          unsubscribe()
          refreshers.delete(requestRefresh)
        })
      })
      // The documented automatic JSX runtime lets this one text contribution
      // share the host renderer without a separate Babel/JSX build pipeline.
      return jsx("text", {
        get content() {
          if (!props.sessionID) return label("none", budget())
          if (unavailable()) return label("unavailable", budget())
          const current = selection()
          if (!current) return label("…", budget())
          return label(current.workspace?.name ?? "none", budget(), current.instructions === "blocked")
        },
        get fg() { return unavailable() || selection()?.instructions === "blocked" ? context.theme.text.feedback.warning.base : context.theme.text.muted },
        get maxWidth() { return budget() },
        wrapMode: "none", truncate: true, flexShrink: 0,
      })
    },
  })
  return { refresh() { for (const refresh of refreshers) refresh() }, dispose: unregister }
}
