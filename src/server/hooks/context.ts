import type { SessionContext } from "@opencode/plugin/promise/session"
import path from "node:path"
import type { Catalog } from "../catalog/catalog.ts"
import { slash } from "../filesystem/paths.ts"
import { instructionBlock } from "../instructions/render.ts"
import type { InstructionSnapshot } from "../instructions/types.ts"
import { HELPER_TOOLS, workspaceSystemText } from "../prompts.ts"
import type { ChangedEmitter } from "../rpc-handlers.ts"
import type { ServerRuntime } from "../runtime.ts"
import type { InactiveResolution } from "../sessions/bindings.ts"
import { captureActiveBinding, verifySessionLocation } from "../sessions/guards.ts"

export async function registerContextHook(runtime: ServerRuntime, emitChanged: ChangedEmitter) {
  await runtime.ctx.session.hook("context", async (event) => {
    // Synchronous, before the first await: this request now blocks attachment.
    runtime.admission.markStarted(event.sessionID)
    const resolved = await runtime.bindings.resolve(event.sessionID)
    if (resolved.mode !== "active") {
      keepNativeRequest(runtime, event, resolved)
      return
    }
    await deliverWorkspaceContext(runtime, emitChanged, event)
  })
}

// Inactive sessions keep native behavior; only a known active session fails closed.
function keepNativeRequest(
  runtime: ServerRuntime,
  event: SessionContext,
  resolved: InactiveResolution,
): void {
  for (const name of HELPER_TOOLS) delete event.tools[name]
  if (resolved.mode === "unavailable" && runtime.bindings.isKnownActive(event.sessionID))
    throw resolved.error
}

async function deliverWorkspaceContext(
  runtime: ServerRuntime,
  emitChanged: ChangedEmitter,
  event: SessionContext,
): Promise<void> {
  const { sessionID } = event
  await verifySessionLocation(runtime, sessionID)
  const catalog = await runtime.catalogs.writer(false)
  const binding = captureActiveBinding(catalog, sessionID, runtime.directory)
  const delivery = runtime.instructions.ensureDelivery(
    sessionID,
    binding.workspace.roots,
    authorizeSource(runtime, sessionID),
  )
  const models = await runtime.ctx.model.list()
  const model = models.data.find(
    (candidate) =>
      candidate.providerID === event.model.providerID && candidate.id === event.model.id,
  )
  runtime.instructions.setStatus(sessionID, "not-loaded")
  let snapshot: InstructionSnapshot
  try {
    snapshot = await delivery.capture(model?.limit.context ?? 0)
    runtime.instructions.setStatus(sessionID, snapshot.errors.length ? "blocked" : "ready")
  } catch (error) {
    runtime.instructions.setStatus(sessionID, "blocked")
    throw error
  } finally {
    await announceSelection(catalog, emitChanged, sessionID)
  }
  event.system.push({
    type: "text",
    text: workspaceSystemText(binding.workspace, instructionBlock(snapshot)),
  })
}

// Instruction reads go through native external-directory and read permissions.
function authorizeSource(runtime: ServerRuntime, sessionID: SessionContext["sessionID"]) {
  return async (source: string) => {
    await runtime.ctx.permission.assert({
      sessionID,
      action: "external_directory",
      resources: [slash(path.dirname(source))],
      save: [],
    })
    await runtime.ctx.permission.assert({
      sessionID,
      action: "read",
      resources: [slash(source)],
      save: [],
    })
  }
}

// A notification must never mask native permission control flow.
async function announceSelection(catalog: Catalog, emitChanged: ChangedEmitter, sessionID: string) {
  try {
    const meta = catalog.selection(sessionID)
    await emitChanged({ catalogID: meta.catalogID, revision: meta.revision, sessionID })
  } catch {
    // Swallowed: the request's own outcome (including a permission error) stands.
  }
}
