import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { WorkspaceError } from "../domain.ts"

const code = (error: unknown) => (error as NodeJS.ErrnoException).code

export async function registryLock(registry: string, signal: AbortSignal): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(registry), { recursive: true, mode: 0o700 })
  const file = `${registry}.lock`
  const token = randomUUID()
  const deadline = Date.now() + 5_000
  while (true) {
    signal.throwIfAborted()
    try {
      const handle = await fs.open(file, "wx", 0o600)
      let written = false
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }))
        written = true
      } finally {
        await handle.close()
        if (!written) await fs.unlink(file)
      }
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(file, "utf8")) as { token?: unknown }
          if (current.token === token) await fs.unlink(file)
        } catch (error) { if (code(error) !== "ENOENT") throw error }
      }
    } catch (error) { if (code(error) !== "EEXIST") throw error }
    try {
      const info = await fs.lstat(file)
      if (info.isFile() && Date.now() - info.mtimeMs > 30_000 && info.size < 4096) {
        const owner = JSON.parse(await fs.readFile(file, "utf8")) as { pid?: unknown }
        if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) } catch (error) { if (code(error) === "ESRCH") await fs.unlink(file) }
        }
      }
    } catch (error) { if (code(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error }
    if (Date.now() >= deadline) throw new WorkspaceError("REGISTRY_BUSY", "Workspace registry is locked by another process; retry shortly")
    await delay(40, undefined, { signal })
  }
}