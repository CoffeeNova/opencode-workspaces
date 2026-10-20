import { Error as ToolError, type Info, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { Workspace } from "../../shared/schemas.ts"
import { isInside, resolvePath } from "../filesystem/paths.ts"
import { checkedTarget } from "../filesystem/policy.ts"
import { RESOLVE_TOOL_DESCRIPTION } from "../prompts.ts"
import type { ServerRuntime } from "../runtime.ts"
import { requireActiveBinding } from "../sessions/guards.ts"

const ResolveInput = z.object({ path: z.string().min(1) }).strict()
const ALIAS_PATH = /^([a-z0-9_-]+):\/(.*)$/s

export function resolveTool(runtime: ServerRuntime): Info {
  return {
    name: "workspace_resolve",
    description: RESOLVE_TOOL_DESCRIPTION,
    input: z.toJSONSchema(ResolveInput),
    options: { codemode: false },
    execute: (raw, context) => resolveAliasPath(runtime, raw, context),
  }
}

async function resolveAliasPath(runtime: ServerRuntime, raw: unknown, context: ToolContext) {
  context.signal.throwIfAborted()
  const { workspace } = await requireActiveBinding(runtime, context.sessionID)
  const input = ResolveInput.parse(raw)
  const { root, relative } = aliasTarget(input.path, workspace.roots)
  const candidate = resolvePath(relative || ".", root.path)
  if (!isInside(root.path, candidate))
    throw new ToolError({ message: "OUTSIDE_ROOT: alias traversal is not allowed" })
  const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
  if (relative.replaceAll("\\", "/").split("/").includes(".."))
    await runtime.ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source,
      action: "workspace_escape",
      resources: [candidate],
      save: [],
      metadata: { workspaceManager: true },
    })
  await runtime.ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    source,
    action: "external_directory",
    resources: [root.path],
    save: [],
  })
  const checked = await checkedTarget(candidate, workspace.roots)
  if (!checked) throw new ToolError({ message: "OUTSIDE_ROOT" })
  await runtime.instructions.deliveryFor(context.sessionID)?.discover([checked])
  return { content: JSON.stringify({ path: checked, alias: root.alias }) }
}

// Splits `alias:/relative/path` into a registered root and its root-relative path.
function aliasTarget(value: string, roots: Workspace["roots"]) {
  const match = ALIAS_PATH.exec(value)
  const alias = match?.[1]
  const relative = match?.[2]
  const root = roots.find((candidate) => candidate.alias === alias)
  if (!root || relative === undefined || relative.startsWith("/") || /^[a-z]:/i.test(relative))
    throw new ToolError({
      message: "INVALID_PATH: use a registered alias:/relative/path",
    })
  return { root, relative }
}
