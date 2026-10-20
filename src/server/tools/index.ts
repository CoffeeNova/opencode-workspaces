import type { ServerRuntime } from "../runtime.ts"
import { resolveTool } from "./resolve-tool.ts"
import { searchTool } from "./search-tools.ts"
import { statusTool } from "./status-tool.ts"

export async function registerWorkspaceTools(runtime: ServerRuntime) {
  await runtime.ctx.tool.transform((editor) => {
    editor.add(searchTool(runtime, "glob"))
    editor.add(searchTool(runtime, "grep"))
    editor.add(statusTool(runtime))
    editor.add(resolveTool(runtime))
  })
}
