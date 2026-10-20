import { type Dirent } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import ignore, { type Ignore } from "ignore"
import { errorCode, WorkspaceError } from "../../shared/errors.ts"
import { SEARCH_LIMITS } from "../../shared/limits.ts"
import { isInside, pathKey, resolvePath, slash } from "../filesystem/paths.ts"
import { assertNotDenied } from "../filesystem/policy.ts"
import { boundedRead, decodeUtf8 } from "../filesystem/safe-read.ts"

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
type PendingDirectory = { directory: string; layers: IgnoreLayer[] }
type WalkOptions = {
  beforeRead?: (file: string) => Promise<void>
  maxEntries?: number
  skipRoots?: readonly SearchRoot[]
  excludes?: readonly Bun.Glob[]
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

function isDenied(file: string): boolean {
  try {
    assertNotDenied(file)
    return false
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "DENIED_PATH") return true
    throw error
  }
}

function isExcluded(
  entry: Dirent,
  relative: string,
  excludes: readonly Bun.Glob[] | undefined,
): boolean {
  if (!excludes) return false
  return excludes.some(
    (pattern) => pattern.match(relative) || (entry.isDirectory() && pattern.match(`${relative}/`)),
  )
}

function isSkipped(
  entry: Dirent,
  file: string,
  relative: string,
  layers: IgnoreLayer[],
  options: WalkOptions,
): boolean {
  const name = process.platform === "win32" ? entry.name.toLowerCase() : entry.name
  if (name === ".git" || entry.isSymbolicLink()) return true
  if (isDenied(file)) return true
  if (options.skipRoots?.some((other) => isInside(other.path, file))) return true
  if (isExcluded(entry, relative, options.excludes)) return true
  return isIgnored(file, entry.isDirectory(), layers)
}

async function assertDirectoryUnchanged(directory: string, root: SearchRoot): Promise<void> {
  const real = resolvePath(await fs.realpath(directory), root.path)
  if (pathKey(real) !== pathKey(directory) || !isInside(root.path, real))
    throw new WorkspaceError(
      "PATH_CHANGED",
      "A directory changed during the scan; retry the operation",
    )
}

async function withGitignore(
  current: PendingDirectory,
  signal: AbortSignal,
  options: WalkOptions,
): Promise<IgnoreLayer[]> {
  const layers = [...current.layers]
  const ignoreFile = path.join(current.directory, ".gitignore")
  const info = await fs.lstat(ignoreFile).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error
    return undefined
  })
  if (!info?.isFile()) return layers
  await options.beforeRead?.(slash(ignoreFile))
  const result = await boundedRead(ignoreFile, SEARCH_LIMITS.readBytes, signal)
  if (result.truncated)
    throw new WorkspaceError("IGNORE_TOO_LARGE", `.gitignore exceeds 200 KB: ${slash(ignoreFile)}`)
  layers.push({ directory: current.directory, rules: ignore().add(decodeUtf8(result.bytes)) })
  return layers
}

async function listEntries(
  directory: string,
  signal: AbortSignal,
  scan: { visited: number },
  maxEntries: number,
): Promise<Dirent[]> {
  const entries: Dirent[] = []
  for await (const entry of await fs.opendir(directory)) {
    signal.throwIfAborted()
    if (++scan.visited > maxEntries)
      throw new WorkspaceError(
        "SEARCH_LIMIT",
        "Per-root entry scan limit reached; narrow the pattern or alias",
      )
    entries.push(entry)
  }
  entries.sort((first, second) => first.name.localeCompare(second.name, "en"))
  return entries
}

async function resolveFile(
  root: SearchRoot,
  file: string,
  relative: string,
  seen: Set<string>,
): Promise<FileEntry | undefined> {
  try {
    const canonical = resolvePath(await fs.realpath(file), root.path)
    assertNotDenied(canonical)
    if (!isInside(root.path, canonical) || pathKey(canonical) !== pathKey(file))
      throw new WorkspaceError("PATH_CHANGED", "A file changed during the scan")
    if (seen.has(pathKey(canonical))) return undefined
    const info = await fs.stat(canonical)
    if (!info.isFile()) return undefined
    seen.add(pathKey(canonical))
    return {
      root,
      absolute: canonical,
      relative,
      file: `${root.alias}:/${relative}`,
      mtime: info.mtimeMs,
      size: info.size,
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return undefined
  }
}

export async function* walk(
  roots: readonly SearchRoot[],
  signal: AbortSignal,
  options: WalkOptions = {},
): AsyncGenerator<FileEntry> {
  const seen = new Set<string>()
  const scan = { visited: 0 }
  for (const root of roots) {
    const queue: PendingDirectory[] = [{ directory: root.path, layers: [] }]
    for (let current = queue.pop(); current; current = queue.pop()) {
      signal.throwIfAborted()
      await assertDirectoryUnchanged(current.directory, root)
      const layers = await withGitignore(current, signal, options)
      const entries = await listEntries(
        current.directory,
        signal,
        scan,
        options.maxEntries ?? Infinity,
      )
      const directories: PendingDirectory[] = []
      for (const entry of entries) {
        signal.throwIfAborted()
        const file = slash(path.join(current.directory, entry.name))
        const relative = slash(path.relative(root.path, file))
        if (isSkipped(entry, file, relative, layers, options)) continue
        if (entry.isDirectory()) {
          directories.push({ directory: file, layers })
        } else if (entry.isFile()) {
          const found = await resolveFile(root, file, relative, seen)
          if (found) yield found
        }
      }
      queue.push(...directories.reverse())
    }
  }
}
