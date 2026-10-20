import type { ServerRuntime } from "../runtime.ts"
import { resolveTool } from "./resolve-tool.ts"
import { searchTool } from "./search-tools.ts"
import { statusTool } from "./status-tool.ts"

// Helper schemas offered to active sessions only; passive requests drop them.
export const HELPER_TOOLS = [
  "workspace_glob",
  "workspace_grep",
  "workspace_status",
  "workspace_resolve",
] as const

export async function registerWorkspaceTools(runtime: ServerRuntime) {
  await runtime.ctx.tool.transform((editor) => {
    editor.add(searchTool(runtime, "glob"))
    editor.add(searchTool(runtime, "grep"))
    editor.add(statusTool(runtime))
    editor.add(resolveTool(runtime))
  })
}
