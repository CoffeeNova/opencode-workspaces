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
export type InstructionLimits = { file: number; aggregate: number }

export class InstructionError extends Error {
  constructor(
    readonly code: "INSTRUCTIONS_REQUIRED" | "INSTRUCTIONS_UNAVAILABLE" | "UNSUPPORTED_TARGET",
    detail: string,
  ) {
    super(`${code}: ${detail}`)
  }
}
