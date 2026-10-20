import { Plugin } from "@opencode/plugin/tui"
import { errorText } from "../shared/errors.ts"
import { workspaceClient } from "./client.ts"
import { registerWorkspaceIndicator } from "./indicator/indicator.ts"
import { runMenu, type MenuEntry } from "./menu/main-menu.ts"
import { MenuSession } from "./menu/session.ts"
import { currentTarget, type MenuTarget } from "./target.ts"

// Slash name, menu entry, and command title.
const MENU_COMMANDS = [
  ["workspace", "main", "Manage workspaces"],
  ["workspace-add", "add", "Add workspace folder"],
  ["workspace-switch", "switch", "Switch workspace"],
] as const satisfies readonly (readonly [string, MenuEntry, string])[]

export default Plugin.define({
  id: "workspace-manager.v2.tui",
  setup(context) {
    const rpc = workspaceClient(context)
    const lifetime = new AbortController()
    const indicator = registerWorkspaceIndicator(context)
    let running = false
    // One menu at a time. The target is captured synchronously so that a
    // second open cannot slip in before `running` is set.
    async function open(entry: MenuEntry) {
      if (running || lifetime.signal.aborted) return
      let target: MenuTarget
      try {
        target = currentTarget(context)
      } catch (error) {
        await context.ui.dialog.alert({ title: "Workspace unavailable", message: errorText(error) })
        return
      }
      running = true
      try {
        await runMenu(new MenuSession(context, rpc, indicator, target, lifetime.signal), entry)
      } finally {
        running = false
      }
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: MENU_COMMANDS.map(([name, entry, title]) => ({
        id: `workspace-manager.${name}`,
        title,
        group: "Workspace",
        slash: { name },
        palette: true,
        run: () => open(entry),
      })),
    }))
    return () => {
      lifetime.abort()
      indicator.dispose()
    }
  },
})
