import { Error as ToolError } from "@opencode/plugin/promise/tool"
import * as fs from "node:fs/promises"
import { WorkspaceError } from "../../shared/errors.ts"
import type { Binding } from "../../shared/schemas.ts"
import type { Catalog } from "../catalog/catalog.ts"
import { toWorkspaceFailure } from "../failures.ts"
import { pathKey } from "../filesystem/paths.ts"
import type { ServerRuntime } from "../runtime.ts"
import type { ActiveBinding } from "./bindings.ts"

// Workspace management only runs in the session's own Location.
export async function verifySessionLocation(runtime: ServerRuntime, sessionID: string) {
  const session = await runtime.ctx.session.get({ sessionID })
  if (pathKey(await fs.realpath(session.location.directory)) !== pathKey(runtime.directory))
    throw new WorkspaceError(
      "LOCATION_MISMATCH",
      "Reopen workspace management in the session's own Location",
    )
  return session
}

// Only an unsealed session with empty native history that has not started a request.
export async function canAttach(
  runtime: ServerRuntime,
  sessionID: string | undefined,
  binding: Binding | null,
): Promise<boolean> {
  if (!sessionID || binding?.sealed || !runtime.admission.admits(sessionID)) return false
  const empty = (await runtime.ctx.session.context({ sessionID })).length === 0
  return empty && runtime.admission.admits(sessionID)
}

// Seals the session's binding on first capture; a missing workspace fails closed.
export function captureActiveBinding(
  catalog: Catalog,
  sessionID: string,
  directory: string,
): ActiveBinding {
  const binding = catalog.capture(sessionID, directory)
  if (!binding?.workspace)
    throw new WorkspaceError(
      "BINDING_UNAVAILABLE",
      "The active workspace binding disappeared; restore its catalog before continuing",
    )
  return { ...binding, workspace: binding.workspace }
}

// Helper tools run only for an attached session; failures surface as tool errors.
export async function requireActiveBinding(
  runtime: ServerRuntime,
  sessionID: string,
): Promise<ActiveBinding> {
  runtime.admission.markStarted(sessionID)
  try {
    const resolved = await runtime.bindings.resolve(sessionID)
    if (resolved.mode === "unavailable") throw resolved.error
    if (resolved.mode === "passive")
      throw new WorkspaceError(
        "NO_WORKSPACE",
        "Explicitly select a workspace through /workspace in an empty or new session",
      )
    await verifySessionLocation(runtime, sessionID)
    const catalog = await runtime.catalogs.writer(false)
    return captureActiveBinding(catalog, sessionID, runtime.directory)
  } catch (error) {
    const problem = toWorkspaceFailure(error)
    throw new ToolError({ message: problem.message })
  }
}
