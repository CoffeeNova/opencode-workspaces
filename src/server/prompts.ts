import { SEARCH_LIMITS } from "../shared/limits.ts"
import type { Workspace } from "../shared/schemas.ts"
import type { SearchInput } from "./search/search.ts"

type SearchKind = SearchInput["kind"]

const SEARCH_SUBJECT = {
  glob: "file paths by relative glob (also alias:/glob)",
  grep: "UTF-8 content by JavaScript regex, optionally filtered by include glob",
} as const satisfies Record<SearchKind, string>

const SEARCH_RESULTS = {
  glob: SEARCH_LIMITS.globResults,
  grep: SEARCH_LIMITS.grepResults,
} as const satisfies Record<SearchKind, number>

// Helper schemas offered to active sessions only; passive requests drop them.
export const HELPER_TOOLS = [
  "workspace_glob",
  "workspace_grep",
  "workspace_status",
  "workspace_resolve",
] as const

export const STATUS_TOOL_DESCRIPTION =
  "Show this session's explicit pinned workspace selection. No global active selection; saved-definition edits do not retarget running sessions."

export const RESOLVE_TOOL_DESCRIPTION =
  "Resolve alias:/relative/path to a canonical absolute native-tool path in this session. Prepares scoped instructions for the next model request; never reads file contents or changes files."

export function searchToolDescription(kind: SearchKind): string {
  return `Search this session's pinned workspace ${SEARCH_SUBJECT[kind]}. Defaults to all roots; optional alias narrows to one. Honors nested .gitignore and exclude globs; skips sensitive paths and links. Deterministic per-root quotas share ${SEARCH_RESULTS[kind]} results. Reports partial/truncated/unavailable roots. Grep skips binary and >200 KiB files; scan/byte budgets and cancellation apply.`
}

// System context for an active session, followed by its scoped instruction block.
export function workspaceSystemText(
  workspace: Pick<Workspace, "name" | "revision">,
  block: string,
): string {
  return `Workspace ${JSON.stringify(workspace.name)}, pinned revision ${workspace.revision}. Saved-definition changes do not retarget this session. Native tools use absolute paths; shell requires an explicit workdir. Use workspace_glob/workspace_grep for safe multi-root search, optionally filtered by alias. Results include alias-qualified paths and per-root partial/truncation status; narrow the query when incomplete.\n${block}`
}
