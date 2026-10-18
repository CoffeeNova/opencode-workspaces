import { Plugin } from "@opencode/plugin/tui"
import type { LocationRef } from "@opencode/client"
import { CapabilityProbe, TuiProbe } from "./rpc.ts"
import { checkDialogFlow } from "./dialog-flow.ts"

export default Plugin.define({
  id: "workspace-manager.capability-probe.tui",
  async setup(context) {
    const probe = context.client.rpc(CapabilityProbe)
    const telemetry = context.client.rpc(TuiProbe)
    const instanceID = crypto.randomUUID()
    const commandID = "workspace-manager.capability-probe.open"
    let running = false
    let disposed = false
    const pending = new AbortController()
    const traceOptions = () => ({ location: context.location ?? context.data.location.default(), signal: AbortSignal.timeout(5000) })
    const commandCopies = () => context.keymap.commands().filter((command) => command.id === commandID).length
    const target = () => {
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const session = sessionID ? context.data.session.get(sessionID) : undefined
      const location: LocationRef = session?.location ?? context.location ?? context.data.location.default()
      return { route: { ...route }, sessionID, session, location: { ...location } }
    }
    const unsubscribe = context.data.listen(({ details }) => {
      if (disposed || details.type !== "session.created") return
      void telemetry.record({ instanceID, event: "session-event", commandCopies: commandCopies(), sessionID: details.data.sessionID }, traceOptions()).catch(() => {})
    })
    const register = () => context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: commandID,
        title: "Workspace capability probe",
        group: "Workspace development",
        slash: { name: "workspace-probe" },
        palette: true,
        enabled: () => !running && !disposed,
        async run() {
          if (running || disposed) return
          running = true
          let current = () => !disposed
          try {
            const { route, sessionID, session, location } = target()
            current = () => {
              const next = target()
              return !disposed && next.route.type === route.type && next.sessionID === sessionID
                && (!sessionID || next.session !== undefined)
                && (route.type !== "plugin" || (next.route.type === "plugin" && next.route.name === route.name))
                && next.location.directory === location.directory && next.location.workspaceID === location.workspaceID
            }
            // Never fall back to the launch Location for an uncached session.
            if (sessionID && !session) {
              await context.ui.dialog.alert({ title: "Workspace probe", message: "Session metadata is loading. Reopen the probe." })
              return
            }
            void telemetry.record({ instanceID, event: "command", commandCopies: commandCopies(), ...(sessionID ? { sessionID } : {}) }, traceOptions()).catch(() => {})
            if (!current()) return
            const action = await context.ui.dialog.select({
              title: "Workspace capability probe",
              options: [
                { title: "Check typed RPC", value: "inspect", description: "Metadata only; no model or workspace mutation" },
                { title: "Check dialog navigation", value: "dialogs", description: "Native select/prompt replacement; no saved changes" },
              ],
            })
            if (!action || !current()) return
            if (action === "dialogs") return await checkDialogFlow(context.ui.dialog, current)
            const result = await probe.inspect(sessionID ? { sessionID } : {}, { location, signal: pending.signal })
            if (!current()) return
            await context.ui.dialog.alert({
              title: "Workspace probe: RPC ready",
              message: `OpenCode ${result.runtimeVersion}\n${result.directory}\nSession: ${result.session?.id ?? "none (home)"}`,
            })
          } catch (error) {
            const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : String(error)
            if (current()) await context.ui.dialog.alert({ title: "Workspace probe failed", message })
          } finally {
            running = false
          }
        },
      }],
    }))
    try {
      register()
      await telemetry.record({ instanceID, event: "setup", commandCopies: commandCopies() }, traceOptions())
    }
    catch (error) {
      disposed = true
      unsubscribe()
      pending.abort()
      throw error
    }
    // Keymap layers are owned and removed by the host on unload.
    return async () => {
      disposed = true
      unsubscribe()
      pending.abort()
      if (running) context.ui.dialog.clear()
      await telemetry.record({ instanceID, event: "cleanup", commandCopies: commandCopies() }, traceOptions()).catch(() => {})
    }
  },
})
