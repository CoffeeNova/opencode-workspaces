import { expect, test } from "bun:test"
import { INDICATOR_TIMING } from "../../src/shared/limits.ts"
import { label } from "../../src/tui/indicator.ts"

const FAMILY = "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"

// Characterization: literal outputs observed from the indicator before the split.
test.each([
  ["alpha", 28, false, "[ws:alpha]"],
  ["workspace-beta-very-long-display-name-for-small-terminals", 21, false, "[ws:workspace-beta-…]"],
  ["日本語のワークスペース名", 12, false, "[ws:日本語…]"],
  [`${FAMILY}family`, 10, false, `[ws:${FAMILY}fa…]`],
  ["e\u0301tude", 8, false, "[ws:e\u0301t…]"],
  ["alpha", 28, true, "[ws:alpha!]"],
  ["workspace-beta-very-long-display-name-for-small-terminals", 21, true, "[ws:workspace-beta…!]"],
  ["日本語のワークスペース名", 12, true, "[ws:日本…!]"],
  [`${FAMILY}family`, 10, true, `[ws:${FAMILY}f…!]`],
  ["e\u0301tude", 8, true, "[ws:e\u0301…!]"],
] as const)("fits %p into %p columns (blocked: %p)", (name, columns, blocked, expected) => {
  expect(label(name, columns, blocked)).toBe(expected)
})

// The budget is still an inline closure in the indicator; this is its expression verbatim.
function labelBudget(columns: number) {
  return Math.min(
    INDICATOR_TIMING.maxColumns,
    Math.max(INDICATOR_TIMING.minColumns, Math.floor(columns / 3)),
  )
}

test.each([
  [10, 8],
  [30, 10],
  [64, 21],
  [84, 28],
  [200, 28],
] as const)("label budget at %p columns is %p", (columns, expected) => {
  expect(labelBudget(columns)).toBe(expected)
})
