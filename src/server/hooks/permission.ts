import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { ServerRuntime } from "../runtime.ts"

export async function registerPermissionHook(runtime: ServerRuntime) {
  await runtime.ctx.permission.hook("evaluate", (event) => {
    if (escalatesToAsk(runtime, event)) event.effect = "ask"
  })
}

// An active session's own workspace_escape request always asks unless already denied.
function escalatesToAsk(runtime: ServerRuntime, event: PermissionEvaluation): boolean {
  return (
    runtime.bindings.isKnownActive(event.sessionID) &&
    event.action === "workspace_escape" &&
    event.metadata?.workspaceManager === true &&
    event.effect !== "deny"
  )
}
