import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Alias, Name, Root, WorkspaceError } from "../domain.ts"
import type { Catalog } from "./catalog.ts"
import { absolute, assertNotDenied, canonicalTarget, expanded, pathKey, slash } from "./paths.ts"
import { registryLock } from "./registry-lock.ts"
import { boundedRead, decode } from "./search.ts"

const LIMIT = 4 * 1024 * 1024
const Legacy = z.object({
  $schema: z.string().optional(), version: z.literal(1), active: z.string().nullable(),
  workspaces: z.record(z.string(), z.object({ name: Name, createdAt: z.string(), roots: z.array(Root).max(20) }).strict()),
}).strict()
const fingerprint = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

async function sourcePath(raw: string, base: string) {
  const candidate = absolute(raw, base)
  assertNotDenied(candidate)
  if (path.extname(candidate).toLowerCase() !== ".json") throw new WorkspaceError("INVALID_REGISTRY", "Select the legacy workspace JSON registry, not a database")
  return slash(path.join(await canonicalTarget(path.dirname(candidate)), path.basename(candidate)))
}

async function readLegacy(source: string, signal: AbortSignal) {
  signal.throwIfAborted()
  assertNotDenied(source)
  const read = await boundedRead(source, LIMIT, signal)
  if (read.truncated) throw new WorkspaceError("INVALID_REGISTRY", "Legacy registry exceeds 4 MiB")
  let value: unknown
  try { value = JSON.parse(decode(read.bytes)) } catch { throw new WorkspaceError("INVALID_REGISTRY", "Legacy registry is not valid UTF-8 JSON; nothing was imported") }
  if (value && typeof value === "object" && "workspaces" in value && value.workspaces && typeof value.workspaces === "object") {
    if (Object.keys(value.workspaces).some((name) => !Name.safeParse(name).success || name.trim() !== name)) throw new WorkspaceError("INVALID_REGISTRY", "Invalid legacy workspace key")
  }
  const parsed = Legacy.safeParse(value)
  if (!parsed.success) throw new WorkspaceError("INVALID_REGISTRY", "Unsupported or malformed legacy registry; only version 1 is accepted")
  const workspaces = Object.entries(parsed.data.workspaces)
  if (workspaces.length > 1000 || (parsed.data.active !== null && !Object.hasOwn(parsed.data.workspaces, parsed.data.active))) throw new WorkspaceError("INVALID_REGISTRY", "Invalid legacy workspace count or active name")
  for (const [name, workspace] of workspaces) {
    if (name !== workspace.name) throw new WorkspaceError("INVALID_REGISTRY", "Legacy workspace key and name differ")
    const aliases = new Set<string>()
    const paths = new Set<string>()
    for (const root of workspace.roots) {
      const value = expanded(root.path)
      if (!path.isAbsolute(value) || value.split("/").includes("..")) throw new WorkspaceError("INVALID_REGISTRY", "Legacy roots must be absolute without traversal")
      root.path = absolute(value, path.dirname(source))
      assertNotDenied(root.path)
      Alias.parse(root.alias)
      if (aliases.has(root.alias) || paths.has(pathKey(root.path))) throw new WorkspaceError("INVALID_REGISTRY", "Duplicate legacy root or alias")
      aliases.add(root.alias); paths.add(pathKey(root.path))
    }
  }
  return { bytes: read.bytes, fingerprint: fingerprint(read.bytes), active: parsed.data.active, workspaces: workspaces.map(([, workspace]) => ({ name: workspace.name, roots: workspace.roots })) }
}

export async function previewLegacy(raw: string, base: string, signal: AbortSignal) {
  const source = await sourcePath(raw, base)
  const read = await readLegacy(source, signal)
  return { sourcePath: source, fingerprint: read.fingerprint, active: read.active, workspaces: read.workspaces.map((workspace) => ({ name: workspace.name, rootCount: workspace.roots.length })) }
}

export async function backupLegacy(source: string, bytes: Buffer, signal: AbortSignal, stamp = new Date().toISOString().replace(/[:.]/g, "-")) {
  for (let attempt = 0; attempt < 64; attempt++) {
    signal.throwIfAborted()
    const backup = `${source}.backup-${stamp}${attempt ? `-${attempt}` : ""}.json`
    let handle: fs.FileHandle
    try { handle = await fs.open(backup, "wx", 0o600) } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error }
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(backup), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
    signal.throwIfAborted()
    const saved = await boundedRead(backup, LIMIT, signal)
    if (saved.truncated || !saved.bytes.equals(bytes)) throw new WorkspaceError("BACKUP_FAILED", "Backup verification failed; nothing was imported")
    return slash(backup)
  }
  throw new WorkspaceError("BACKUP_FAILED", "Too many backup name collisions; no existing backup was overwritten")
}

export async function importLegacy(catalog: Catalog, input: { path: string; fingerprint: string; expectedRevision: number }, base: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const source = await sourcePath(input.path, base)
  const previous = catalog.imported(source, input.fingerprint)
  if (previous) return previous
  await fs.lstat(source)
  const unlock = await registryLock(source, signal)
  let committed = false
  try {
    const replay = catalog.imported(source, input.fingerprint)
    if (replay) { committed = true; return replay }
    const read = await readLegacy(source, signal)
    if (read.fingerprint !== input.fingerprint) throw new WorkspaceError("IMPORT_CHANGED", "Legacy registry changed after preview; preview it again")
    if (catalog.state().revision !== input.expectedRevision) throw new WorkspaceError("REVISION_CONFLICT", "Workspace data changed; preview the import again")
    const backupPath = await backupLegacy(source, read.bytes, signal)
    const current = await readLegacy(source, signal)
    if (current.fingerprint !== read.fingerprint) throw new WorkspaceError("IMPORT_CHANGED", "Legacy registry changed during backup; nothing was imported")
    signal.throwIfAborted()
    const result = catalog.importLegacy({ sourcePath: source, fingerprint: read.fingerprint, backupPath, active: read.active, workspaces: read.workspaces }, input.expectedRevision)
    committed = true
    return result
  } finally {
    try { await unlock() } catch (error) { if (!committed) throw error }
  }
}