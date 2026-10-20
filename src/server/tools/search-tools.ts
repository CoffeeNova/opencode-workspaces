import { Error as ToolError, type Info, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { WorkspaceError } from "../../shared/errors.ts"
import { SEARCH_LIMITS } from "../../shared/limits.ts"
import { Alias } from "../../shared/schemas.ts"
import { searchToolDescription } from "../prompts.ts"
import type { ServerRuntime } from "../runtime.ts"
import { searchWorkspace, type SearchInput } from "../search/search.ts"
import { requireActiveBinding } from "../sessions/guards.ts"

type SearchKind = SearchInput["kind"]

const SearchFields = {
  pattern: z.string().min(1).max(SEARCH_LIMITS.patternLength),
  alias: Alias.optional(),
}
const SearchExclude = z
  .array(z.string().min(1).max(SEARCH_LIMITS.patternLength))
  .max(SEARCH_LIMITS.excludes)
  .optional()

export const GlobSearch = z.object({ ...SearchFields, exclude: SearchExclude }).strict()
export const GrepSearch = z
  .object({
    ...SearchFields,
    include: z.string().min(1).max(SEARCH_LIMITS.patternLength).optional(),
    exclude: SearchExclude,
  })
  .strict()

export function parseSearchInput(kind: SearchKind, raw: unknown): SearchInput | undefined {
  if (kind === "glob") {
    const parsed = GlobSearch.safeParse(raw)
    return parsed.success ? { kind, ...parsed.data } : undefined
  }
  const parsed = GrepSearch.safeParse(raw)
  return parsed.success ? { kind, ...parsed.data } : undefined
}

export function searchTool(runtime: ServerRuntime, kind: SearchKind): Info {
  return {
    name: `workspace_${kind}`,
    description: searchToolDescription(kind),
    input: z.toJSONSchema(kind === "glob" ? GlobSearch : GrepSearch),
    options: { codemode: false },
    execute: (raw, context) => runSearch(runtime, kind, raw, context),
  }
}

async function runSearch(
  runtime: ServerRuntime,
  kind: SearchKind,
  raw: unknown,
  context: ToolContext,
) {
  context.signal.throwIfAborted()
  const { workspace } = await requireActiveBinding(runtime, context.sessionID)
  const input = parseSearchInput(kind, raw)
  if (!input)
    throw new ToolError({
      message: "INVALID_PATTERN: invalid workspace search arguments",
    })
  const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
  try {
    const result = await searchWorkspace(workspace.roots, input, {
      signal: context.signal,
      assert: (action, resource) =>
        runtime.ctx.permission.assert({
          sessionID: context.sessionID,
          agent: context.agent,
          source,
          action,
          resources: [resource],
          save: [],
        }),
    })
    return { content: JSON.stringify(result) }
  } catch (error) {
    // Cancellation and native permission rejection propagate unchanged.
    context.signal.throwIfAborted()
    if (error instanceof WorkspaceError) throw new ToolError({ message: error.message })
    throw error
  }
}
