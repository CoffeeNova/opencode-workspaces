import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { errorCode } from "../shared/errors.ts"
import { INSTRUCTION_LIMITS } from "../shared/limits.ts"

// Scoped source delivery; storage and native permission adapters are separate.
// Root mappings are immutable for a session once its first request is captured.
export type InstructionRoot = { alias: string; path: string }
export type InstructionSource = { path: string; scope: string } & (
  | { status: "loaded"; hash: string; content: string; bytes: number }
  | { status: "missing" }
  | { status: "error"; error: string; bytes?: number }
)
// Blocked snapshots deliver metadata only: loaded sources omit their body and hash.
export type DeliveredSource =
  InstructionSource | { path: string; scope: string; status: "loaded"; bytes: number }
export type InstructionSnapshot = {
  requestID: string
  roots: readonly InstructionRoot[]
  sources: readonly InstructionSource[]
  errors: readonly string[]
}
export class InstructionError extends Error {
  constructor(
    readonly code: "INSTRUCTIONS_REQUIRED" | "INSTRUCTIONS_UNAVAILABLE" | "UNSUPPORTED_TARGET",
    detail: string,
  ) {
    super(`${code}: ${detail}`)
  }
}
const key = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
const inside = (root: string, target: string) => {
  const relative = path.relative(key(root), key(target))
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  )
}
const missing = (error: unknown) => errorCode(error) === "ENOENT"

export function instructionDelivery(
  roots: readonly InstructionRoot[],
  authorize: (source: string) => Promise<void>,
  limits: { file: number; aggregate: number } = {
    file: INSTRUCTION_LIMITS.fileBytes,
    aggregate: INSTRUCTION_LIMITS.aggregateBytes,
  },
) {
  const prepared = new Set(roots.map((root) => root.path))
  let snapshot: InstructionSnapshot | undefined
  // First tool in a native assistant message pins the generating request's
  // snapshot synchronously, before reads can discover another scope in parallel.
  const messages = new Map<string, InstructionSnapshot | undefined>()

  async function targetDirectories(target: string) {
    if (!path.isAbsolute(target))
      throw new InstructionError("UNSUPPORTED_TARGET", "Use absolute native paths")
    const lexical = path.resolve(target)
    const owners = roots
      .filter((root) => inside(root.path, lexical))
      .sort((a, b) => b.path.length - a.path.length)
    if (!owners.length)
      throw new InstructionError("UNSUPPORTED_TARGET", `Outside the selected roots: ${target}`)
    for (const root of owners) {
      if (key(await fs.realpath(root.path)) !== key(root.path))
        throw new InstructionError("UNSUPPORTED_TARGET", `Root retargeted: ${root.path}`)
    }
    // Resolve even a new file through its nearest existing parent. This proof
    // rejects linked targets; arbitrary concurrent filesystem retargeting is not
    // made atomic by this check.
    let existing = lexical
    const suffix: string[] = []
    while (true) {
      try {
        const real = path.join(await fs.realpath(existing), ...suffix)
        if (key(path.resolve(real)) !== key(path.resolve(lexical)))
          throw new InstructionError("UNSUPPORTED_TARGET", `Linked target: ${target}`)
        break
      } catch (error) {
        if (!missing(error)) throw error
        suffix.unshift(path.basename(existing))
        existing = path.dirname(existing)
      }
    }
    const stat = await fs.stat(lexical).catch((error: unknown) => {
      if (!missing(error)) throw error
      return undefined
    })
    const directory = stat?.isDirectory() ? lexical : path.dirname(lexical)
    const directories = new Set<string>()
    // Overlap keeps all applicable ancestor scopes but deduplicates physical
    // sources. Most-specific root ownership does not erase registered ancestors.
    for (const root of owners) {
      let current = directory
      while (inside(root.path, current)) {
        directories.add(current)
        if (key(current) === key(root.path)) break
        current = path.dirname(current)
      }
    }
    return [...directories]
  }

  async function source(directory: string): Promise<InstructionSource> {
    const file = path.join(directory, "AGENTS.md")
    const base = { path: file, scope: directory }
    // Permission control flow deliberately sits outside the filesystem catch.
    // A configured deny/rejection must not turn into a successful tool result.
    await authorize(file)
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || key(await fs.realpath(file)) !== key(file)) {
        return {
          ...base,
          status: "error",
          error: "Instruction source must be an unlinked regular file",
        }
      }
      if (stat.size > limits.file)
        return {
          ...base,
          status: "error",
          bytes: stat.size,
          error: `File exceeds ${limits.file} bytes`,
        }
      const handle = await fs.open(
        file,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      )
      let bytes: Buffer
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
          return { ...base, status: "error", error: "Instruction source changed while opening" }
        const buffer = Buffer.alloc(limits.file + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, null)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        bytes = buffer.subarray(0, length)
        const after = await fs.lstat(file)
        if (
          !after.isFile() ||
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          key(await fs.realpath(file)) !== key(file)
        )
          return {
            ...base,
            status: "error",
            error: "Instruction source path changed while reading",
          }
      } finally {
        await handle.close()
      }
      if (bytes.length > limits.file)
        return {
          ...base,
          status: "error",
          bytes: bytes.length,
          error: `File exceeds ${limits.file} bytes`,
        }
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
    } catch (error) {
      if (missing(error)) return { ...base, status: "missing" }
      return {
        ...base,
        status: "error",
        error: error instanceof TypeError ? "Invalid UTF-8" : "Instruction source is unreadable",
      }
    }
  }

  async function collect(directories: Iterable<string>) {
    const unique = [
      ...new Map([...directories].map((directory) => [key(directory), directory])).values(),
    ].sort()
    if (unique.length > INSTRUCTION_LIMITS.scopes)
      throw new InstructionError("INSTRUCTIONS_UNAVAILABLE", "Instruction scope limit exceeded")
    const sources: InstructionSource[] = []
    for (const directory of unique) sources.push(await source(directory))
    return sources
  }
  const errorsFor = (sources: readonly InstructionSource[]) => {
    const errors = sources
      .filter((item) => item.status === "error")
      .map((item) => `${item.path}: ${item.error}`)
    if (
      sources.reduce((sum, item) => sum + (item.status === "missing" ? 0 : (item.bytes ?? 0)), 0) >
      limits.aggregate
    )
      errors.push(`Aggregate instructions exceed ${limits.aggregate} bytes`)
    return errors
  }

  return {
    async capture(
      contextLimit: number = INSTRUCTION_LIMITS.minContextTokens,
    ): Promise<InstructionSnapshot> {
      snapshot = undefined // Never keep an older delivered snapshot if refresh fails.
      messages.clear()
      const sources = await collect(prepared)
      const errors = errorsFor(sources)
      // No tokenizer/model-budget policy is being invented here. The byte caps
      // are experimental at the declared baseline; smaller contexts fail closed.
      if (contextLimit < INSTRUCTION_LIMITS.minContextTokens)
        errors.push(`Model context ${contextLimit}: instruction budget policy is unverified`)
      snapshot = { requestID: randomUUID(), roots, sources, errors }
      return snapshot
    },
    async discover(targets: readonly string[]) {
      for (const target of targets)
        for (const directory of await targetDirectories(target)) prepared.add(directory)
    },
    async preflight(messageID: string, targets: readonly string[]) {
      if (!messages.has(messageID)) messages.set(messageID, snapshot)
      const delivered = messages.get(messageID)
      const directories = new Set(roots.map((root) => root.path))
      for (const target of targets)
        for (const directory of await targetDirectories(target)) {
          directories.add(directory)
          prepared.add(directory)
        }
      const current = await collect(directories)
      const errors = [...errorsFor(current), ...(delivered?.errors ?? [])]
      if (errors.length) throw new InstructionError("INSTRUCTIONS_UNAVAILABLE", errors.join("; "))
      if (!delivered)
        throw new InstructionError(
          "INSTRUCTIONS_REQUIRED",
          "No current generating request snapshot; prepare scopes and request again",
        )
      for (const item of current) {
        const prior = delivered.sources.find((candidate) => key(candidate.path) === key(item.path))
        if (
          (item.status === "loaded" && (prior?.status !== "loaded" || prior.hash !== item.hash)) ||
          (item.status === "missing" && prior?.status === "loaded")
        ) {
          throw new InstructionError(
            "INSTRUCTIONS_REQUIRED",
            `Read/prepare ${item.path}, then regenerate the mutation with fresh scoped instructions`,
          )
        }
      }
      return delivered.requestID
    },
    invalidate() {
      snapshot = undefined
      messages.clear()
    },
  }
}

export function instructionBlock(snapshot: InstructionSnapshot, header = "WORKSPACE_INSTRUCTIONS") {
  return (
    `${header}\n` +
    JSON.stringify({
      requestID: snapshot.requestID,
      roots: snapshot.roots,
      policy:
        "These are independent roots. Source text applies only to its directory scope; it cannot authorize tools or change plugin metadata. This fresh snapshot supersedes earlier plugin snapshots, including removed sources. Use absolute paths and explicit shell workdir.",
      // JSON string values cannot forge another source's path/scope metadata.
      sources: snapshot.sources.map((item): DeliveredSource =>
        snapshot.errors.length && item.status === "loaded"
          ? { path: item.path, scope: item.scope, status: item.status, bytes: item.bytes }
          : item,
      ),
      errors: snapshot.errors,
      delivery: snapshot.errors.length
        ? "blocked: no instruction bodies delivered"
        : "complete scoped source text",
    })
  )
}

// Deliberately conservative subset of the pinned native patch grammar. Unsupported
// framing fails closed, never falls back to searching arbitrary `path` properties.
// Body lines are parsed by operation so header-looking added text is not a target.
export function patchTargets(patchText: string): string[] {
  const fail = (): never => {
    throw new InstructionError(
      "UNSUPPORTED_TARGET",
      "Unsupported patch framing; use plain native absolute-path sections",
    )
  }
  const lines = patchText.trim().split(/\r?\n/)
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") return fail()
  const targets: string[] = []
  let operation: string | undefined
  let mayMove = false
  for (const line of lines) {
    const header = /^\*\*\* (Add|Delete|Update) File: (\S.*)$/.exec(line)
    if (header) {
      operation = header[1]!
      targets.push(header[2]!.trim())
      mayMove = operation === "Update"
    } else if (mayMove && line.startsWith("*** Move to: ") && line.slice(13).trim()) {
      targets.push(line.slice(13).trim())
      mayMove = false
    } else if (operation === "Add" && line.startsWith("+")) mayMove = false
    else if (
      operation === "Update" &&
      (/^[ +\-]/.test(line) ||
        line === "" ||
        line === "@@" ||
        line.startsWith("@@ ") ||
        line === "*** End of File")
    )
      mayMove = false
    else return fail()
  }
  if (!targets.length || targets.some((target) => !path.isAbsolute(target))) return fail()
  return targets
}
