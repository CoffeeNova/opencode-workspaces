import { Error as ToolError, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { WorkspaceError } from "../../shared/errors.ts"
import type { Workspace } from "../../shared/schemas.ts"
import { toWorkspaceFailure } from "../failures.ts"
import { expandPath, resolvePath } from "../filesystem/paths.ts"
import { checkedTarget, overlapsRoots } from "../filesystem/policy.ts"
import { patchTargets } from "../instructions/patch-targets.ts"
import { InstructionError } from "../instructions/types.ts"
import type { ServerRuntime } from "../runtime.ts"
import { verifySessionLocation } from "../sessions/guards.ts"

const NATIVE_GUARDED_TOOLS: readonly string[] = [
  "read",
  "edit",
  "write",
  "patch",
  "shell",
  "glob",
  "grep",
]

// Native tool input is unknown; only these string fields can name a preflight target.
const NativeTarget = z.object({
  path: z.string().optional().catch(undefined),
  patchText: z.string().optional().catch(undefined),
  workdir: z.string().optional().catch(undefined),
})
type NativeTarget = z.infer<typeof NativeTarget>

type NativeCall = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id"> & {
  tool: string
  input: unknown
}
type Roots = Workspace["roots"]

export async function registerToolPreflight(runtime: ServerRuntime) {
  await runtime.ctx.tool.hook("execute.before", async (event) => {
    // Synchronous, before the first await: this request now blocks attachment.
    runtime.admission.markStarted(event.sessionID)
    if (!NATIVE_GUARDED_TOOLS.includes(event.tool)) return
    try {
      await preflightNativeTool(runtime, event)
    } catch (error) {
      const problem = error instanceof InstructionError ? error : toWorkspaceFailure(error)
      throw new ToolError({ message: problem.message })
    }
  })
}

async function preflightNativeTool(runtime: ServerRuntime, event: NativeCall): Promise<void> {
  const resolved = await runtime.bindings.resolve(event.sessionID)
  if (resolved.mode === "passive") return
  if (resolved.mode === "unavailable") {
    if (runtime.bindings.isKnownActive(event.sessionID)) throw resolved.error
    return
  }
  const roots = resolved.binding.workspace.roots
  await verifySessionLocation(runtime, event.sessionID)
  const parsed = NativeTarget.safeParse(event.input)
  const input: NativeTarget = parsed.success ? parsed.data : {}
  if (event.tool === "glob" || event.tool === "grep") {
    await guardNativeSearch(runtime.directory, input, roots)
    return
  }
  await guardNativeTargets(runtime, event, input, roots)
}

// Native search cannot apply workspace ignore and sensitive-path policy.
async function guardNativeSearch(directory: string, input: NativeTarget, roots: Roots) {
  const searchDirectory = input.path !== undefined ? resolvePath(input.path, directory) : directory
  if (await overlapsRoots(searchDirectory, roots))
    throw new WorkspaceError(
      "USE_WORKSPACE_SEARCH",
      "Use workspace_glob or workspace_grep for bound roots; native search cannot enforce workspace ignore and sensitive-path policy",
    )
}

// Covered targets need current scoped instructions: reads discover, mutations preflight.
async function guardNativeTargets(
  runtime: ServerRuntime,
  event: NativeCall,
  input: NativeTarget,
  roots: Roots,
) {
  const targets = nativeTargets(event.tool, input)
  if (!targets.length)
    throw new WorkspaceError("INVALID_PATH", "An explicit native path or shell workdir is required")
  const covered = await coveredTargets(runtime, event, targets, roots)
  if (!covered.length) return
  const delivery = runtime.instructions.deliveryFor(event.sessionID)
  if (!delivery)
    throw new WorkspaceError(
      "INSTRUCTIONS_REQUIRED",
      "A fresh workspace request is required before native tools",
    )
  if (event.tool === "read") await delivery.discover(covered)
  else await delivery.preflight(event.messageID, covered)
}

// A `..` segment needs explicit workspace_escape approval before its target is checked.
async function coveredTargets(
  runtime: ServerRuntime,
  event: NativeCall,
  targets: readonly string[],
  roots: Roots,
) {
  const covered: string[] = []
  for (const target of targets) {
    if (expandPath(target).split("/").includes(".."))
      await runtime.ctx.permission.assert({
        sessionID: event.sessionID,
        agent: event.agent,
        source: { type: "tool", messageID: event.messageID, id: event.id },
        action: "workspace_escape",
        resources: [target],
        save: [],
        metadata: { workspaceManager: true },
      })
    const checked = await checkedTarget(target, roots)
    if (checked) covered.push(checked)
  }
  return covered
}

function nativeTargets(tool: string, input: NativeTarget): string[] {
  if (tool === "patch" && input.patchText !== undefined) return patchTargets(input.patchText)
  if (tool === "shell" && input.workdir !== undefined) return [input.workdir]
  if (tool !== "shell" && input.path !== undefined) return [input.path]
  return []
}
