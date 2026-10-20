import type { Plugin } from "@opencode/plugin"
import { CatalogAccess } from "./catalog/catalog-access.ts"
import { SessionInstructions } from "./instructions/session-instructions.ts"
import { SessionAdmission } from "./sessions/admission.ts"
import { BindingResolver } from "./sessions/bindings.ts"

// Every stateful owner of one plugin instance, passed to handlers, hooks and tools.
export type ServerRuntime = {
  ctx: Plugin.Context
  directory: string
  catalogs: CatalogAccess
  admission: SessionAdmission
  bindings: BindingResolver
  instructions: SessionInstructions
}

export function createRuntime(
  ctx: Plugin.Context,
  directory: string,
  configuredPath: string | undefined,
): ServerRuntime {
  const catalogs = new CatalogAccess(configuredPath, directory)
  return {
    ctx,
    directory,
    catalogs,
    admission: new SessionAdmission(),
    bindings: new BindingResolver(directory, catalogs),
    instructions: new SessionInstructions(),
  }
}

export function disposeRuntime(runtime: ServerRuntime): void {
  runtime.instructions.clear()
  runtime.bindings.clear()
  runtime.admission.clear()
  runtime.catalogs.dispose()
}
