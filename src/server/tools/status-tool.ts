import type { Info } from "@opencode/plugin/promise/tool"
import { STATUS_TOOL_DESCRIPTION } from "../prompts.ts"
import type { ServerRuntime } from "../runtime.ts"
import { requireActiveBinding } from "../sessions/guards.ts"

export function statusTool(runtime: ServerRuntime): Info {
  return {
    name: "workspace_status",
    description: STATUS_TOOL_DESCRIPTION,
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: async (_input, context) => {
      context.signal.throwIfAborted()
      const binding = await requireActiveBinding(runtime, context.sessionID)
      return { content: JSON.stringify(binding) }
    },
  }
}
