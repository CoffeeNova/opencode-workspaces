import { Plugin } from "@opencode/plugin/tui"
import { WorkspaceNotifications } from "./rpc.ts"

export default Plugin.define({
  id: "workspace-manager.notifications.tui",
  setup(context) {
    const notifications = context.client.rpc(WorkspaceNotifications)
    const stop = notifications.events.on("toast", (event) => {
      const current = context.location ?? context.data.location.default()
      const normalize = (value: string | null | undefined) => {
        const normalized = value?.replaceAll("\\", "/").replace(/\/$/, "")
        return process.platform === "win32" ? normalized?.toLowerCase() : normalized
      }
      if (!current?.directory || !event.location.directory || normalize(current.directory) !== normalize(event.location.directory)) return
      context.ui.toast.show({ title: "workspace-manager", ...event.data, duration: 4500 })
    })
    return stop
  },
})
