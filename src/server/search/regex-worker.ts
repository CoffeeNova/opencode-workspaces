import { Worker } from "node:worker_threads"
import { z } from "zod"
import { WorkspaceError } from "../../shared/errors.ts"
import { SEARCH_LIMITS } from "../../shared/limits.ts"

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

function timeoutError(): WorkspaceError {
  return new WorkspaceError(
    "REGEX_TIMEOUT",
    "Fallback regex exceeded its one-second timeout; simplify the pattern or install ripgrep",
  )
}

export class RegexMatcher {
  private readonly worker: Worker
  private readonly timeoutMs: number
  private failure: Error | undefined

  constructor(pattern: string, timeoutMs: number = SEARCH_LIMITS.regexTimeoutMs) {
    this.timeoutMs = timeoutMs
    this.worker = new Worker(REGEX_WORKER, { eval: true, workerData: pattern })
    this.worker.on("error", (error: Error) => {
      this.failure = error
    })
  }

  async match(content: string, limit: number, signal: AbortSignal): Promise<RegexHit[]> {
    signal.throwIfAborted()
    if (this.failure) throw this.failure
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(timeoutError()), this.timeoutMs)
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
