import { Plugin } from "@opencode/plugin"
import * as fs from "node:fs/promises"
import { slash } from "./filesystem/paths.ts"
import { registerCompactionHook } from "./hooks/compaction.ts"
import { registerContextHook } from "./hooks/context.ts"
import { registerPermissionHook } from "./hooks/permission.ts"
import { registerToolPreflight } from "./hooks/tool-preflight.ts"
import { registerRpcHandlers } from "./rpc-handlers.ts"
import { createRuntime, disposeRuntime, type ServerRuntime } from "./runtime.ts"
import { registerWorkspaceTools } from "./tools/index.ts"

export default Plugin.define({
  id: "workspace-manager.v2",
  async setup(ctx) {
    const catalogPath = configuredCatalogPath(ctx.options)
    const directory = slash(await fs.realpath(ctx.location.directory))
    const runtime = createRuntime(ctx, directory, catalogPath)
    try {
      await registerServer(runtime)
    } catch (error) {
      runtime.catalogs.dispose()
      throw error
    }
    return () => disposeRuntime(runtime)
  },
})

function configuredCatalogPath(options: Plugin.Context["options"]): string | undefined {
  const value = options.catalogPath
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim())
    throw new Error("options.catalogPath must be a non-empty .sqlite path")
  return value
}

// Registration order is unchanged: RPC handlers, then hooks, then helper tools.
async function registerServer(runtime: ServerRuntime) {
  const emitChanged = await registerRpcHandlers(runtime)
  await registerContextHook(runtime, emitChanged)
  await registerCompactionHook(runtime)
  await registerToolPreflight(runtime)
  await registerPermissionHook(runtime)
  await registerWorkspaceTools(runtime)
}
