import path from "node:path"
import { InstructionError } from "./delivery.ts"

const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File: (\S.*)$/
const MOVE_PREFIX = "*** Move to: "

function unsupportedPatch(): never {
  throw new InstructionError(
    "UNSUPPORTED_TARGET",
    "Unsupported patch framing; use plain native absolute-path sections",
  )
}

function isUpdateBodyLine(line: string): boolean {
  return (
    /^[ +\-]/.test(line) ||
    line === "" ||
    line === "@@" ||
    line.startsWith("@@ ") ||
    line === "*** End of File"
  )
}

// Deliberately conservative subset of the pinned native patch grammar. Unsupported
// framing fails closed, never falls back to searching arbitrary `path` properties.
// Body lines are parsed by operation so header-looking added text is not a target.
export function patchTargets(patchText: string): string[] {
  const lines = patchText.trim().split(/\r?\n/)
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
    return unsupportedPatch()
  const targets: string[] = []
  let operation: string | undefined
  let mayMove = false
  for (const line of lines) {
    const header = FILE_HEADER.exec(line)
    const moved = line.slice(MOVE_PREFIX.length).trim()
    if (header) {
      operation = header[1]!
      targets.push(header[2]!.trim())
      mayMove = operation === "Update"
    } else if (mayMove && line.startsWith(MOVE_PREFIX) && moved) {
      targets.push(moved)
      mayMove = false
    } else if (operation === "Add" && line.startsWith("+")) {
      mayMove = false
    } else if (operation === "Update" && isUpdateBodyLine(line)) {
      mayMove = false
    } else {
      return unsupportedPatch()
    }
  }
  if (!targets.length || targets.some((target) => !path.isAbsolute(target)))
    return unsupportedPatch()
  return targets
}
