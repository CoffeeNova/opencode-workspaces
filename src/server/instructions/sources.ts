import { createHash } from "node:crypto"
import type { Stats } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { isNotFound } from "../../shared/errors.ts"
import { resolvedKey } from "../filesystem/paths.ts"
import { fillBuffer, NO_FOLLOW_READ } from "../filesystem/safe-read.ts"
import type { InstructionSource } from "./types.ts"

type SourceBase = { path: string; scope: string }
type StableRead = { bytes: Buffer } | { error: string }

// Reads the AGENTS.md of one directory scope into a loaded, missing or error status.
export async function readInstructionSource(
  directory: string,
  authorize: (source: string) => Promise<void>,
  fileLimit: number,
): Promise<InstructionSource> {
  const file = path.join(directory, "AGENTS.md")
  const base = { path: file, scope: directory }
  // Permission control flow deliberately sits outside the filesystem catch.
  // A configured deny/rejection must not turn into a successful tool result.
  await authorize(file)
  try {
    return await loadSource(base, fileLimit)
  } catch (error) {
    return failedSource(base, error)
  }
}

async function loadSource(base: SourceBase, fileLimit: number): Promise<InstructionSource> {
  const file = base.path
  const stat = await fs.lstat(file)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    resolvedKey(await fs.realpath(file)) !== resolvedKey(file)
  ) {
    return {
      ...base,
      status: "error",
      error: "Instruction source must be an unlinked regular file",
    }
  }
  if (stat.size > fileLimit) return oversizedSource(base, stat.size, fileLimit)
  const read = await readStableBytes(file, stat, fileLimit)
  if ("error" in read) return { ...base, status: "error", error: read.error }
  const { bytes } = read
  if (bytes.length > fileLimit) return oversizedSource(base, bytes.length, fileLimit)
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (content.includes("\0"))
    return { ...base, status: "error", error: "Binary instruction source" }
  return {
    ...base,
    status: "loaded",
    bytes: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
    content,
  }
}

function oversizedSource(base: SourceBase, bytes: number, fileLimit: number): InstructionSource {
  return { ...base, status: "error", bytes, error: `File exceeds ${fileLimit} bytes` }
}

// Reads one byte past the limit so oversized growth is visible, and proves the
// same file was opened and is still at the same path afterwards.
async function readStableBytes(file: string, stat: Stats, fileLimit: number): Promise<StableRead> {
  const handle = await fs.open(file, NO_FOLLOW_READ)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      return { error: "Instruction source changed while opening" }
    const buffer = Buffer.alloc(fileLimit + 1)
    const length = await fillBuffer(handle, buffer)
    const bytes = buffer.subarray(0, length)
    const after = await fs.lstat(file)
    if (
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      resolvedKey(await fs.realpath(file)) !== resolvedKey(file)
    )
      return { error: "Instruction source path changed while reading" }
    return { bytes }
  } finally {
    await handle.close()
  }
}

function failedSource(base: SourceBase, error: unknown): InstructionSource {
  if (isNotFound(error)) return { ...base, status: "missing" }
  return {
    ...base,
    status: "error",
    error: error instanceof TypeError ? "Invalid UTF-8" : "Instruction source is unreadable",
  }
}
