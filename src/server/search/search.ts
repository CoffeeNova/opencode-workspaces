import { errorCode, WorkspaceError } from "../../shared/errors.ts"
import { SEARCH_LIMITS } from "../../shared/limits.ts"
import { isInside, pathKey } from "../filesystem/paths.ts"
import { canonicalDirectory, checkedTarget } from "../filesystem/policy.ts"
import { boundedRead, decodeUtf8 } from "../filesystem/safe-read.ts"
import { assertValidRegex, compileGlob, globScope } from "./patterns.ts"
import { RegexMatcher } from "./regex-worker.ts"
import { walk, type FileEntry, type SearchRoot } from "./walk.ts"

type SearchFilters = { pattern: string; alias?: string | undefined; exclude?: string[] | undefined }
export type GlobSearchInput = SearchFilters & { kind: "glob" }
export type GrepSearchInput = SearchFilters & { kind: "grep"; include?: string | undefined }
export type SearchInput = GlobSearchInput | GrepSearchInput
export type SearchAccess = {
  signal: AbortSignal
  assert: (
    action: "external_directory" | "read" | "glob" | "grep",
    resource: string,
  ) => Promise<void>
}
type RootResult = { alias: string; status: "complete" | "truncated" | "unavailable"; code?: string }
type Match = { file: string; line: number; text: string }
type SearchSummary = {
  roots: RootResult[]
  truncated: boolean
  partial: boolean
  limits: { results: number; entriesPerRoot: number; grepBytesPerRoot: number }
}
export type GlobSearchResult = { files: string[] } & SearchSummary
export type GrepSearchResult = { matches: Match[]; engine: "fs+regex" } & SearchSummary
export type SearchResult = GlobSearchResult | GrepSearchResult

// Failures that mark one root unavailable while the remaining roots are still searched.
const ROOT_UNAVAILABLE_CODES: readonly string[] = [
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "EBUSY",
  "ELOOP",
  "ROOT_CHANGED",
  "PATH_CHANGED",
  "IGNORE_TOO_LARGE",
  "BINARY_FILE",
  "DENIED_PATH",
  "NOT_DIRECTORY",
]

type RootJob = {
  root: SearchRoot
  selected: readonly SearchRoot[]
  input: SearchInput
  include: Bun.Glob | undefined
  excludes: Bun.Glob[] | undefined
  quota: number
  access: SearchAccess
  status: RootResult
  files: string[]
  matches: Match[]
  matcher: () => RegexMatcher
}
type RootProgress = { count: number; bytes: number; permissionRejected: boolean }
type BeforeRead = (file: string) => Promise<void>

function rootQuota(limit: number, rootCount: number, index: number): number {
  return Math.floor(limit / rootCount) + (index < limit % rootCount ? 1 : 0)
}

function recordRootFailure(status: RootResult, error: unknown): void {
  const code = errorCode(error)
  if (error instanceof WorkspaceError && error.code === "SEARCH_LIMIT") {
    status.status = "truncated"
    status.code = error.code
  } else if (code && ROOT_UNAVAILABLE_CODES.includes(code)) {
    status.status = "unavailable"
    status.code = code
  } else throw error
}

async function assertRootUnchanged(root: SearchRoot): Promise<void> {
  if (pathKey(await canonicalDirectory(root.path, root.path)) !== pathKey(root.path))
    throw new WorkspaceError("ROOT_CHANGED", "Root moved or became a link; remove and re-add it")
}

// Returns true when the quota is reached and the root scan should stop.
function collectGlobFile(job: RootJob, progress: RootProgress, file: FileEntry): boolean {
  if (progress.count === job.quota) {
    job.status.status = "truncated"
    return true
  }
  job.files.push(file.file)
  progress.count++
  return false
}

// Returns the decoded text, or undefined when the file is skipped.
async function readGrepContent(
  job: RootJob,
  progress: RootProgress,
  beforeRead: BeforeRead,
  file: FileEntry,
): Promise<string | undefined> {
  const { signal } = job.access
  try {
    await beforeRead(file.absolute)
    const read = await boundedRead(file.absolute, SEARCH_LIMITS.readBytes, signal)
    progress.bytes += read.bytes.length
    if (read.truncated) return undefined
    return decodeUtf8(read.bytes)
  } catch (error) {
    signal.throwIfAborted()
    if (progress.permissionRejected) throw error
    if (
      errorCode(error) === "ENOENT" ||
      (error instanceof WorkspaceError && error.code === "BINARY_FILE")
    )
      return undefined
    throw error
  }
}

// Returns true when the quota is reached and the root scan should stop.
async function collectGrepFile(
  job: RootJob,
  progress: RootProgress,
  beforeRead: BeforeRead,
  file: FileEntry,
): Promise<boolean> {
  if (file.size > SEARCH_LIMITS.readBytes) return false
  if (progress.bytes + file.size > SEARCH_LIMITS.grepBytesPerRoot)
    throw new WorkspaceError(
      "SEARCH_LIMIT",
      "Per-root content byte limit reached; narrow the pattern or alias",
    )
  const content = await readGrepContent(job, progress, beforeRead, file)
  if (content === undefined) return false
  const limit = job.quota - progress.count + 1
  const hits = await job.matcher().match(content, limit, job.access.signal)
  for (const hit of hits) {
    if (progress.count === job.quota) {
      job.status.status = "truncated"
      break
    }
    job.matches.push({
      file: file.file,
      line: hit.line,
      text: `${hit.text}${hit.clipped ? " ... [line truncated]" : ""}`,
    })
    progress.count++
  }
  return job.status.status === "truncated"
}

async function searchRoot(job: RootJob): Promise<void> {
  const { root, selected, input, include, excludes, access, status } = job
  const progress: RootProgress = { count: 0, bytes: 0, permissionRejected: false }
  const beforeRead: BeforeRead = async (file) => {
    access.signal.throwIfAborted()
    await checkedTarget(file, [root])
    try {
      await access.assert("read", file)
    } catch (error) {
      progress.permissionRejected = true
      throw error
    }
    access.signal.throwIfAborted()
  }
  await access.assert("external_directory", root.path)
  await access.assert(input.kind, input.pattern)
  try {
    await assertRootUnchanged(root)
    for await (const file of walk([root], access.signal, {
      beforeRead,
      maxEntries: SEARCH_LIMITS.entriesPerRoot,
      ...(excludes ? { excludes } : {}),
      skipRoots: selected.filter(
        (other) => pathKey(other.path) !== pathKey(root.path) && isInside(root.path, other.path),
      ),
    })) {
      if (include && !include.match(file.relative)) continue
      const stop =
        input.kind === "glob"
          ? collectGlobFile(job, progress, file)
          : await collectGrepFile(job, progress, beforeRead, file)
      if (stop) break
    }
  } catch (error) {
    access.signal.throwIfAborted()
    if (progress.permissionRejected) throw error
    recordRootFailure(status, error)
  }
}

export function searchWorkspace(
  roots: readonly SearchRoot[],
  input: GlobSearchInput,
  access: SearchAccess,
): Promise<GlobSearchResult>
export function searchWorkspace(
  roots: readonly SearchRoot[],
  input: GrepSearchInput,
  access: SearchAccess,
): Promise<GrepSearchResult>
export function searchWorkspace(
  roots: readonly SearchRoot[],
  input: SearchInput,
  access: SearchAccess,
): Promise<SearchResult>
export async function searchWorkspace(
  roots: readonly SearchRoot[],
  input: SearchInput,
  access: SearchAccess,
): Promise<SearchResult> {
  access.signal.throwIfAborted()
  const scope =
    input.kind === "glob"
      ? globScope(input.pattern, input.alias)
      : { pattern: input.pattern, alias: input.alias }
  const selected = roots.filter((root) => scope.alias === undefined || root.alias === scope.alias)
  if (scope.alias !== undefined && !selected.length)
    throw new WorkspaceError(
      "UNKNOWN_ALIAS",
      "Unknown root alias in this session's pinned workspace",
    )
  const include =
    input.kind === "glob"
      ? compileGlob(scope.pattern)
      : input.include === undefined
        ? undefined
        : compileGlob(input.include)
  const excludes = input.exclude?.map(compileGlob)
  if (input.kind === "grep") assertValidRegex(input.pattern)
  const limit = input.kind === "glob" ? SEARCH_LIMITS.globResults : SEARCH_LIMITS.grepResults
  const files: string[] = []
  const matches: Match[] = []
  const statuses: RootResult[] = []
  let matcher: RegexMatcher | undefined
  try {
    for (const [index, root] of selected.entries()) {
      access.signal.throwIfAborted()
      const status: RootResult = { alias: root.alias, status: "complete" }
      statuses.push(status)
      await searchRoot({
        root,
        selected,
        input,
        include,
        excludes,
        quota: rootQuota(limit, selected.length, index),
        access,
        status,
        files,
        matches,
        matcher: () => (matcher ??= new RegexMatcher(input.pattern)),
      })
    }
  } finally {
    await matcher?.close()
  }
  access.signal.throwIfAborted()
  const summary: SearchSummary = {
    roots: statuses,
    truncated: statuses.some((root) => root.status === "truncated"),
    partial: statuses.some((root) => root.status !== "complete"),
    limits: {
      results: limit,
      entriesPerRoot: SEARCH_LIMITS.entriesPerRoot,
      grepBytesPerRoot: SEARCH_LIMITS.grepBytesPerRoot,
    },
  }
  return input.kind === "glob" ? { files, ...summary } : { matches, engine: "fs+regex", ...summary }
}
