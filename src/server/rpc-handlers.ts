import type { RpcCallContext } from "@opencode/plugin/promise/rpc"
import type { z } from "zod"
import { WorkspaceRPC } from "../shared/rpc-contract.ts"
import type { Change, ChangedEvent, Workspace } from "../shared/schemas.ts"
import { toWorkspaceFailure } from "./failures.ts"
import { browseDirectory } from "./filesystem/browse.ts"
import { canonicalDirectory } from "./filesystem/policy.ts"
import type { ServerRuntime } from "./runtime.ts"
import { canAttach, verifySessionLocation } from "./sessions/guards.ts"

export type ChangedEmitter = (payload: z.infer<typeof ChangedEvent>) => Promise<void>

type WorkspaceCall = RpcCallContext<(typeof WorkspaceRPC)["methods"]["state"]>

export async function registerRpcHandlers(runtime: ServerRuntime): Promise<ChangedEmitter> {
  // Only called from handlers, which run after registration has assigned `rpc`.
  const emitChanged: ChangedEmitter = (payload) => rpc.events.emit("changed", payload)
  const rpc = await runtime.ctx.rpc.register(WorkspaceRPC, {
    selection: (input, call) => handle(call, () => readSelection(runtime, input.sessionID)),
    state: (input, call) => handle(call, () => readState(runtime, input.sessionID)),
    change: (input, call) => handle(call, () => applyChange(runtime, input, call, emitChanged)),
    browse: (input, call) => handle(call, () => browse(runtime, input.path, call.signal)),
  })
  return emitChanged
}

// Workspace failures become the typed `workspace` RPC error; anything else propagates.
async function handle<T>(call: WorkspaceCall, work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    const problem = toWorkspaceFailure(error)
    return call.error("workspace", problem.message, { code: problem.code })
  }
}

async function readSelection(runtime: ServerRuntime, sessionID: string) {
  await verifySessionLocation(runtime, sessionID)
  const { binding, ...meta } = await runtime.bindings.selection(sessionID)
  return {
    ...meta,
    workspace: workspaceSummary(binding?.workspace),
    sealed: binding?.sealed ?? false,
    instructions: runtime.instructions.status(sessionID),
  }
}

function workspaceSummary(workspace: Workspace | null | undefined) {
  if (!workspace) return null
  return {
    id: workspace.id,
    name: workspace.name,
    revision: workspace.revision,
    rootCount: workspace.roots.length,
  }
}

async function readState(runtime: ServerRuntime, sessionID: string | undefined) {
  if (sessionID) await verifySessionLocation(runtime, sessionID)
  const current = await runtime.catalogs.reader()
  const state = current?.state(sessionID) ?? {
    catalogID: null,
    revision: 0,
    workspaces: [],
    binding: null,
  }
  if (sessionID) runtime.bindings.remember(sessionID, state.binding)
  return { ...state, canAttach: await canAttach(runtime, sessionID, state.binding) }
}

async function applyChange(
  runtime: ServerRuntime,
  input: Change,
  call: WorkspaceCall,
  emitChanged: ChangedEmitter,
) {
  const { sessionID, action } = input
  call.signal.throwIfAborted()
  if (sessionID) await verifySessionLocation(runtime, sessionID)
  const catalog = await runtime.catalogs.writer(action.kind === "create")
  const binding = sessionID ? catalog.selection(sessionID).binding : null
  const bindingChange = action.kind === "attach" || action.kind === "detach"
  const empty = await canAttach(runtime, sessionID, binding)
  const root =
    action.kind === "addRoot" ? await canonicalDirectory(action.path, runtime.directory) : undefined
  call.signal.throwIfAborted()
  // No await separates this admission check from the SQLite commit.
  // A context/tool hook marks started synchronously at entry: either
  // attach commits first or that request permanently rejects attach.
  const admitted = empty && runtime.admission.admits(sessionID)
  const result = catalog.change(input, runtime.directory, admitted, root)
  if (sessionID) {
    if (action.kind === "detach" && !result.binding?.workspace)
      runtime.bindings.forgetActive(sessionID)
    runtime.bindings.remember(sessionID, result.binding)
  }
  // Notification failure cannot change a committed result. Other
  // clients also reconcile through cheap authoritative selection reads.
  try {
    await emitChanged({
      catalogID: result.catalogID,
      revision: result.revision,
      ...(bindingChange && sessionID ? { sessionID } : {}),
    })
  } catch {
    // Swallowed: the change is already committed.
  }
  return {
    ...result,
    canAttach: admitted && !result.binding?.sealed && runtime.admission.admits(sessionID),
  }
}

async function browse(runtime: ServerRuntime, path: string | undefined, signal: AbortSignal) {
  signal.throwIfAborted()
  // Authenticated human administration: directory metadata only, even
  // at home. No instruction/content reads or invented tool context.
  const result = await browseDirectory(path ?? runtime.directory, runtime.directory)
  signal.throwIfAborted()
  return result
}
