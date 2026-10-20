import type { Context, SlotMap } from "@opencode/plugin/tui/context"
import { CliRenderEvents } from "@opentui/core"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createComponent, createEffect, createSignal, onCleanup, Show } from "solid-js"
import { WorkspaceRPC } from "../../shared/rpc-contract.ts"
import type { Selection } from "../../shared/schemas.ts"
import { fitLabel, labelBudget } from "./label.ts"
import { watchSelection } from "./selection-poller.ts"

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
      const budget = () => labelBudget(columns())
      const resize = () => setColumns(context.renderer.width)
      context.renderer.on(CliRenderEvents.RESIZE, resize)
      onCleanup(() => context.renderer.off(CliRenderEvents.RESIZE, resize))

      // Re-runs whenever the route or the displayed session changes.
      createEffect(() => {
        const route = context.ui.router.current()
        const sessionID = props.sessionID
        const location = sessionID ? context.data.session.get(sessionID)?.location : undefined
        const visible = route.type === "session" && route.sessionID === sessionID
        setSelection(undefined)
        setUnavailable(false)
        if (!visible || !sessionID || !location?.directory) return
        const stop = watchSelection({
          rpc,
          context,
          sessionID,
          location,
          knownActive,
          onSelection: setSelection,
          onUnavailable: setUnavailable,
          refreshers,
        })
        onCleanup(stop)
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
              if (unavailable()) return fitLabel("unavailable", budget())
              const current = selection()
              return current?.workspace
                ? fitLabel(current.workspace.name, budget(), current.instructions === "blocked")
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
