export const CATALOG_LIMITS = {
  roots: 20,
  workspaces: 1000,
  bindings: 10_000,
  receipts: 256,
  busyTimeoutMs: 5000,
  nameLength: 100,
  aliasLength: 100,
  suggestedAliasLength: 90,
} as const

export const SESSION_LIMITS = {
  admissionMarkers: 10_000,
  inactiveCache: 2048,
} as const

export const SEARCH_LIMITS = {
  globResults: 200,
  grepResults: 100,
  entriesPerRoot: 10_000,
  grepBytesPerRoot: 8 * 1024 * 1024,
  readBytes: 200 * 1024,
  patternLength: 4096,
  excludes: 32,
  lineClip: 2000,
  regexTimeoutMs: 1000,
} as const

export const INSTRUCTION_LIMITS = {
  fileBytes: 32 * 1024,
  aggregateBytes: 64 * 1024,
  minContextTokens: 128_000,
  scopes: 128,
} as const

export const BROWSE_LIMITS = {
  directories: 100,
} as const

export const INDICATOR_TIMING = {
  requestTimeoutMs: 5000,
  retryMs: 2000,
  maxRetryMs: 10_000,
  minColumns: 8,
  maxColumns: 28,
} as const
