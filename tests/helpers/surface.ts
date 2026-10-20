// Helpers for the golden surface test: turning observed behavior into stable data.
import { Database } from "bun:sqlite"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import { z } from "zod"

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ESCAPE_DEPTH = 3

// Every spelling of the temp base that can appear in observed text: raw,
// slash-normalized, and JSON-escaped once and twice more.
function pathForms(base: string) {
  const forms = new Set<string>()
  for (const form of [base, base.replaceAll("\\", "/")]) {
    let escaped = form
    for (let depth = 0; depth < ESCAPE_DEPTH; depth++) {
      forms.add(escaped)
      escaped = JSON.stringify(escaped).slice(1, -1)
    }
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

// Temp paths appear raw, slash-normalized and JSON-escaped: once inside the
// instruction block, and once more when that text is serialized again.
export function normalizePaths(text: string, base: string) {
  let result = text
  for (const form of pathForms(base)) {
    result = result.replaceAll(form, "<base>")
  }
  return result.replace(UUID, "<uuid>")
}

function splitMultilineStrings(_key: string, item: unknown) {
  return typeof item === "string" && item.includes("\n") ? item.split("\n") : item
}

// A JSON round trip drops undefined fields and functions, keeping only data.
// Multi-line strings become line arrays: Bun would print a nested one after a
// trailing space, which whitespace tooling could strip and so break the match.
export function plainData(value: unknown, base: string): unknown {
  return JSON.parse(normalizePaths(JSON.stringify(value), base), splitMultilineStrings)
}

// Writes to a catalog file directly, as a corrupting or bulk-loading peer would.
export function sql(file: string, statement: string, ...params: string[]) {
  const db = new Database(file)
  try {
    db.query(statement).run(...params)
  } finally {
    db.close()
  }
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) throw error
  const code = "code" in error && typeof error.code === "string" ? error.code : null
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : null
  return { code, tag, message: error.message }
}

export async function failure(attempt: () => Promise<unknown>) {
  try {
    await attempt()
  } catch (error) {
    return describeError(error)
  }
  throw new Error("Expected the operation to fail")
}

export async function outcome(attempt: () => Promise<unknown>) {
  try {
    await attempt()
    return "completed"
  } catch (error) {
    return describeError(error)
  }
}

// Validation rules that JSON Schema cannot express (trim and refine).
export function validation(schema: z.ZodType, value: string) {
  const result = schema.safeParse(value)
  return result.success ? { data: result.data } : { issues: result.error.issues }
}

// Answers a select dialog with the value of the option titled `title`.
export function pick(title: string) {
  return (options: DialogSelectOptions<string>) => {
    return options.options.find((option) => option.title === title)?.value
  }
}
