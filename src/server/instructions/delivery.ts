import { randomUUID } from "node:crypto"
import { INSTRUCTION_LIMITS } from "../../shared/limits.ts"
import { resolvedKey } from "../filesystem/paths.ts"
import { instructionDirectories } from "./scopes.ts"
import { readInstructionSource } from "./sources.ts"
import {
  InstructionError,
  type InstructionLimits,
  type InstructionRoot,
  type InstructionSnapshot,
  type InstructionSource,
} from "./types.ts"

// Scoped source delivery; storage and native permission adapters are separate.
export type InstructionDelivery = {
  capture(contextLimit?: number): Promise<InstructionSnapshot>
  discover(targets: readonly string[]): Promise<void>
  preflight(messageID: string, targets: readonly string[]): Promise<string>
  invalidate(): void
}

export function createInstructionDelivery(
  roots: readonly InstructionRoot[],
  authorize: (source: string) => Promise<void>,
  limits: InstructionLimits = {
    file: INSTRUCTION_LIMITS.fileBytes,
    aggregate: INSTRUCTION_LIMITS.aggregateBytes,
  },
): InstructionDelivery {
  const prepared = new Set(roots.map((root) => root.path))
  let snapshot: InstructionSnapshot | undefined
  // First tool in a native assistant message pins the generating request's
  // snapshot synchronously, before reads can discover another scope in parallel.
  const messages = new Map<string, InstructionSnapshot | undefined>()

  async function collect(directories: Iterable<string>) {
    const unique = [
      ...new Map([...directories].map((directory) => [resolvedKey(directory), directory])).values(),
    ].sort()
    if (unique.length > INSTRUCTION_LIMITS.scopes)
      throw new InstructionError("INSTRUCTIONS_UNAVAILABLE", "Instruction scope limit exceeded")
    const sources: InstructionSource[] = []
    for (const directory of unique)
      sources.push(await readInstructionSource(directory, authorize, limits.file))
    return sources
  }

  return {
    async capture(
      contextLimit: number = INSTRUCTION_LIMITS.minContextTokens,
    ): Promise<InstructionSnapshot> {
      snapshot = undefined // Never keep an older delivered snapshot if refresh fails.
      messages.clear()
      const sources = await collect(prepared)
      const errors = sourceErrors(sources, limits.aggregate)
      // No tokenizer/model-budget policy is being invented here. The byte caps
      // are experimental at the declared baseline; smaller contexts fail closed.
      if (contextLimit < INSTRUCTION_LIMITS.minContextTokens)
        errors.push(`Model context ${contextLimit}: instruction budget policy is unverified`)
      snapshot = { requestID: randomUUID(), roots, sources, errors }
      return snapshot
    },
    async discover(targets: readonly string[]) {
      for (const target of targets)
        for (const directory of await instructionDirectories(roots, target)) prepared.add(directory)
    },
    async preflight(messageID: string, targets: readonly string[]) {
      // Pin before the first await: a parallel read must not discover another scope
      // into the snapshot that generated this message.
      if (!messages.has(messageID)) messages.set(messageID, snapshot)
      const delivered = messages.get(messageID)
      const directories = new Set(roots.map((root) => root.path))
      for (const target of targets)
        for (const directory of await instructionDirectories(roots, target)) {
          directories.add(directory)
          prepared.add(directory)
        }
      const current = await collect(directories)
      const errors = [...sourceErrors(current, limits.aggregate), ...(delivered?.errors ?? [])]
      if (errors.length) throw new InstructionError("INSTRUCTIONS_UNAVAILABLE", errors.join("; "))
      if (!delivered)
        throw new InstructionError(
          "INSTRUCTIONS_REQUIRED",
          "No current generating request snapshot; prepare scopes and request again",
        )
      assertMatchesDelivered(current, delivered)
      return delivered.requestID
    },
    invalidate() {
      snapshot = undefined
      messages.clear()
    },
  }
}

function sourceErrors(sources: readonly InstructionSource[], aggregateLimit: number): string[] {
  const errors = sources
    .filter((item) => item.status === "error")
    .map((item) => `${item.path}: ${item.error}`)
  const total = sources.reduce(
    (sum, item) => sum + (item.status === "missing" ? 0 : (item.bytes ?? 0)),
    0,
  )
  if (total > aggregateLimit) errors.push(`Aggregate instructions exceed ${aggregateLimit} bytes`)
  return errors
}

// A mutation is only allowed when no current source changed since the delivered snapshot.
function assertMatchesDelivered(
  current: readonly InstructionSource[],
  delivered: InstructionSnapshot,
): void {
  for (const item of current) {
    const prior = delivered.sources.find(
      (candidate) => resolvedKey(candidate.path) === resolvedKey(item.path),
    )
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
}
