import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceError } from "../../shared/errors.ts"
import { pathKey, resolvePath } from "./paths.ts"

// Windows has no O_NOFOLLOW; callers that need link safety also check lstat/realpath.
export const NO_FOLLOW_READ =
  constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)

// Reads until the buffer is full or the file ends and returns the bytes read.
// Cancellation is checked before every read, and only when a signal is given.
export async function fillBuffer(handle: fs.FileHandle, buffer: Buffer, signal?: AbortSignal) {
  let length = 0
  while (length < buffer.length) {
    signal?.throwIfAborted()
    const result = await handle.read(buffer, length, buffer.length - length, null)
    if (result.bytesRead === 0) break
    length += result.bytesRead
  }
  return length
}

// Search's bounded read: reads at most min(limit, size) bytes and re-checks the realpath
// after reading. Instruction sources use their own stricter reader in instructions/delivery.ts.
export async function boundedRead(
  file: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  signal?.throwIfAborted()
  const before = await fs.lstat(file)
  if (!before.isFile()) throw new WorkspaceError("NOT_FILE", `Not a regular file: ${file}`)
  const handle = await fs.open(file, NO_FOLLOW_READ)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino)
      throw new WorkspaceError("PATH_CHANGED", "File changed while opening it; retry the operation")
    const buffer = Buffer.alloc(Math.min(limit, Math.max(info.size, 1)))
    const length = await fillBuffer(handle, buffer, signal)
    const after = await handle.stat()
    if (pathKey(resolvePath(await fs.realpath(file), path.dirname(file))) !== pathKey(file))
      throw new WorkspaceError(
        "PATH_CHANGED",
        "File path changed during the read; retry the operation",
      )
    signal?.throwIfAborted()
    return {
      bytes: buffer.subarray(0, length),
      truncated: info.size > length || after.size > length,
    }
  } finally {
    await handle.close()
  }
}

export function decodeUtf8(bytes: Buffer, truncated = false): string {
  if (bytes.includes(0)) throw new WorkspaceError("BINARY_FILE", "Binary files are not supported")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated })
  } catch {
    throw new WorkspaceError("BINARY_FILE", "File is not valid UTF-8 text")
  }
}
