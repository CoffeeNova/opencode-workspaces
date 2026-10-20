import { type Dirent } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"
import ignore, { type Ignore } from "ignore"
import { z } from "zod"
import { errorCode, WorkspaceError } from "../shared/errors.ts"
import { SEARCH_LIMITS } from "../shared/limits.ts"
import { isInside, pathKey, resolvePath, slash } from "../server/filesystem/paths.ts"
import { assertNotDenied, canonicalDirectory, checkedTarget } from "../server/filesystem/policy.ts"
import { boundedRead, decodeUtf8 } from "../server/filesystem/safe-read.ts"

export type SearchRoot = { alias: string; path: string }
export type FileEntry = {
  root: SearchRoot
  absolute: string
  relative: string
  file: string
  mtime: number
  size: number
}
type IgnoreLayer = { directory: string; rules: Ignore }

export function searchPattern(raw: string): Bun.Glob {
  const value = slash(raw.trim())
  if (
    !value ||
    value.length > SEARCH_LIMITS.patternLength ||
    /[\x00-\x1f\x7f]/.test(value) ||
    path.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split("/").includes("..")
  ) {
    throw new WorkspaceError("INVALID_PATTERN", "Use a relative glob without parent traversal")
  }
  try {
    return new Bun.Glob(value)
  } catch {
    throw new WorkspaceError("INVALID_PATTERN", "Invalid glob pattern")
  }
}

export function globScope(
  pattern: string,
  alias: string | undefined,
): { pattern: string; alias: string | undefined } {
  const prefixed = /^([a-z0-9_-]+):\/(.*)$/s.exec(slash(pattern))
  if (!prefixed) return { pattern, alias }
  if (alias !== undefined && alias !== prefixed[1])
    throw new WorkspaceError("INVALID_PATTERN", "Pattern alias and alias argument disagree")
  return { pattern: prefixed[2] || "**/*", alias: prefixed[1] }
}

function isIgnored(file: string, directory: boolean, layers: IgnoreLayer[]): boolean {
  let ignored = false
  for (const layer of layers) {
    const relative = slash(path.relative(layer.directory, file)) + (directory ? "/" : "")
    const result = layer.rules.test(relative)
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

export async function* walk(
  roots: readonly SearchRoot[],
  signal: AbortSignal,
  options: {
    beforeRead?: (file: string) => Promise<void>
    maxEntries?: number
    skipRoots?: readonly SearchRoot[]
    excludes?: readonly Bun.Glob[]
  } = {},
): AsyncGenerator<FileEntry> {
  const seen = new Set<string>()
  let visited = 0
  for (const root of roots) {
    const queue: { directory: string; layers: IgnoreLayer[] }[] = [
      { directory: root.path, layers: [] },
    ]
    while (queue.length) {
      signal.throwIfAborted()
      const current = queue.pop()!
      const real = resolvePath(await fs.realpath(current.directory), root.path)
      if (pathKey(real) !== pathKey(current.directory) || !isInside(root.path, real))
        throw new WorkspaceError(
          "PATH_CHANGED",
          "A directory changed during the scan; retry the operation",
        )
      const layers = [...current.layers]
      const ignoreFile = path.join(current.directory, ".gitignore")
      const info = await fs.lstat(ignoreFile).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error
        return undefined
      })
      if (info?.isFile()) {
        await options.beforeRead?.(slash(ignoreFile))
        const result = await boundedRead(ignoreFile, SEARCH_LIMITS.readBytes, signal)
        if (result.truncated)
          throw new WorkspaceError(
            "IGNORE_TOO_LARGE",
            `.gitignore exceeds 200 KB: ${slash(ignoreFile)}`,
          )
        layers.push({ directory: current.directory, rules: ignore().add(decodeUtf8(result.bytes)) })
      }
      const entries: Dirent[] = []
      for await (const entry of await fs.opendir(current.directory)) {
        signal.throwIfAborted()
        if (++visited > (options.maxEntries ?? Infinity))
          throw new WorkspaceError(
            "SEARCH_LIMIT",
            "Per-root entry scan limit reached; narrow the pattern or alias",
          )
        entries.push(entry)
      }
      entries.sort((first, second) => first.name.localeCompare(second.name, "en"))
      const directories: { directory: string; layers: IgnoreLayer[] }[] = []
      for (const entry of entries) {
        signal.throwIfAborted()
        const file = slash(path.join(current.directory, entry.name))
        if (
          (process.platform === "win32" ? entry.name.toLowerCase() : entry.name) === ".git" ||
          entry.isSymbolicLink()
        )
          continue
        try {
          assertNotDenied(file)
        } catch (error) {
          if (error instanceof WorkspaceError && error.code === "DENIED_PATH") continue
          throw error
        }
        if (options.skipRoots?.some((other) => isInside(other.path, file))) continue
        const relative = slash(path.relative(root.path, file))
        if (
          options.excludes?.some(
            (pattern) =>
              pattern.match(relative) || (entry.isDirectory() && pattern.match(`${relative}/`)),
          )
        )
          continue
        if (isIgnored(file, entry.isDirectory(), layers)) continue
        if (entry.isDirectory()) {
          directories.push({ directory: file, layers })
        } else if (entry.isFile()) {
          try {
            const canonical = resolvePath(await fs.realpath(file), root.path)
            assertNotDenied(canonical)
            if (!isInside(root.path, canonical) || pathKey(canonical) !== pathKey(file))
              throw new WorkspaceError("PATH_CHANGED", "A file changed during the scan")
            if (seen.has(pathKey(canonical))) continue
            const info = await fs.stat(canonical)
            if (!info.isFile()) continue
            seen.add(pathKey(canonical))
            yield {
              root,
              absolute: canonical,
              relative,
              file: `${root.alias}:/${relative}`,
              mtime: info.mtimeMs,
              size: info.size,
            }
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error
          }
        }
      }
      queue.push(...directories.reverse())
    }
  }
}

const REGEX_WORKER = String.raw`
  const { parentPort, workerData } = require("node:worker_threads")
  const regex = new RegExp(workerData, "u")
  parentPort.on("message", ({ content, limit }) => {
    const lines = content.split(/\r?\n/)
    if (lines.at(-1) === "") lines.pop()
    const hits = []
    for (let index = 0; index < lines.length; index++) {
      if (!regex.test(lines[index])) continue
      hits.push({ line: index + 1, text: lines[index].slice(0, ${SEARCH_LIMITS.lineClip}), clipped: lines[index].length > ${SEARCH_LIMITS.lineClip} })
      if (hits.length === limit) break
    }
    parentPort.postMessage(hits)
  })
`
// Worker messages arrive untyped; validate the reply before trusting its shape.
const RegexHits = z.array(
  z.object({ line: z.number().int().positive(), text: z.string(), clipped: z.boolean() }),
)
type RegexHit = z.infer<typeof RegexHits>[number]

export class RegexMatcher {
  private readonly worker: Worker
  private failure: Error | undefined

  constructor(pattern: string) {
    this.worker = new Worker(REGEX_WORKER, { eval: true, workerData: pattern })
    this.worker.on("error", (error: Error) => {
      this.failure = error
    })
  }

  async match(content: string, limit: number, signal: AbortSignal): Promise<RegexHit[]> {
    signal.throwIfAborted()
    if (this.failure) throw this.failure
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new WorkspaceError(
              "REGEX_TIMEOUT",
              "Fallback regex exceeded its one-second timeout; simplify the pattern or install ripgrep",
            ),
          ),
        SEARCH_LIMITS.regexTimeoutMs,
      )
      const cleanup = () => {
        clearTimeout(timer)
        this.worker.off("message", onMessage)
        this.worker.off("error", onError)
        signal.removeEventListener("abort", onAbort)
      }
      const finish = (error: unknown) => {
        cleanup()
        reject(error)
      }
      const onMessage = (message: unknown) => {
        cleanup()
        const hits = RegexHits.safeParse(message)
        if (hits.success) resolve(hits.data)
        else reject(new Error("Regex worker returned an invalid reply"))
      }
      const onError = (error: Error) => finish(error)
      const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"))
      this.worker.once("message", onMessage)
      this.worker.once("error", onError)
      signal.addEventListener("abort", onAbort, { once: true })
      this.worker.postMessage({ content, limit })
    })
  }

  async close(): Promise<void> {
    await this.worker.terminate()
  }
}

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
      ? searchPattern(scope.pattern)
      : input.include === undefined
        ? undefined
        : searchPattern(input.include)
  const excludes = input.exclude?.map(searchPattern)
  if (input.kind === "grep") {
    if (
      !input.pattern ||
      input.pattern.length > SEARCH_LIMITS.patternLength ||
      input.pattern.includes("\0")
    )
      throw new WorkspaceError("INVALID_PATTERN", "Regex must be 1-4096 characters, without NUL")
    try {
      new RegExp(input.pattern, "u")
    } catch {
      throw new WorkspaceError("INVALID_PATTERN", "Invalid JavaScript regular expression")
    }
  }
  const limit = input.kind === "glob" ? SEARCH_LIMITS.globResults : SEARCH_LIMITS.grepResults
  const files: string[] = []
  const matches: Match[] = []
  const statuses: RootResult[] = []
  let matcher: RegexMatcher | undefined
  try {
    for (const [index, root] of selected.entries()) {
      access.signal.throwIfAborted()
      const quota = Math.floor(limit / selected.length) + (index < limit % selected.length ? 1 : 0)
      const status: RootResult = { alias: root.alias, status: "complete" }
      statuses.push(status)
      let count = 0
      let bytes = 0
      let permissionRejected = false
      const beforeRead = async (file: string) => {
        access.signal.throwIfAborted()
        await checkedTarget(file, [root])
        try {
          await access.assert("read", file)
        } catch (error) {
          permissionRejected = true
          throw error
        }
        access.signal.throwIfAborted()
      }
      await access.assert("external_directory", root.path)
      await access.assert(input.kind, input.pattern)
      try {
        if (pathKey(await canonicalDirectory(root.path, root.path)) !== pathKey(root.path))
          throw new WorkspaceError(
            "ROOT_CHANGED",
            "Root moved or became a link; remove and re-add it",
          )
        for await (const file of walk([root], access.signal, {
          beforeRead,
          maxEntries: SEARCH_LIMITS.entriesPerRoot,
          ...(excludes ? { excludes } : {}),
          skipRoots: selected.filter(
            (other) =>
              pathKey(other.path) !== pathKey(root.path) && isInside(root.path, other.path),
          ),
        })) {
          if (include && !include.match(file.relative)) continue
          if (input.kind === "glob") {
            if (count === quota) {
              status.status = "truncated"
              break
            }
            files.push(file.file)
            count++
            continue
          }
          if (file.size > SEARCH_LIMITS.readBytes) continue
          if (bytes + file.size > SEARCH_LIMITS.grepBytesPerRoot)
            throw new WorkspaceError(
              "SEARCH_LIMIT",
              "Per-root content byte limit reached; narrow the pattern or alias",
            )
          let content: string
          try {
            await beforeRead(file.absolute)
            const read = await boundedRead(file.absolute, SEARCH_LIMITS.readBytes, access.signal)
            bytes += read.bytes.length
            if (read.truncated) continue
            content = decodeUtf8(read.bytes)
          } catch (error) {
            access.signal.throwIfAborted()
            if (permissionRejected) throw error
            if (
              errorCode(error) === "ENOENT" ||
              (error instanceof WorkspaceError && error.code === "BINARY_FILE")
            )
              continue
            throw error
          }
          matcher ??= new RegexMatcher(input.pattern)
          const hits = await matcher.match(content, quota - count + 1, access.signal)
          for (const hit of hits) {
            if (count === quota) {
              status.status = "truncated"
              break
            }
            matches.push({
              file: file.file,
              line: hit.line,
              text: `${hit.text}${hit.clipped ? " ... [line truncated]" : ""}`,
            })
            count++
          }
          if (status.status === "truncated") break
        }
      } catch (error) {
        access.signal.throwIfAborted()
        if (permissionRejected) throw error
        const code = errorCode(error)
        if (error instanceof WorkspaceError && error.code === "SEARCH_LIMIT") {
          status.status = "truncated"
          status.code = error.code
        } else if (
          code &&
          [
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
          ].includes(code)
        ) {
          status.status = "unavailable"
          status.code = code
        } else throw error
      }
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
