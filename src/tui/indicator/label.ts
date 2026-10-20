import { INDICATOR_TIMING } from "../../shared/limits.ts"

// `[ws:name]`, with `!` when instructions are blocked. A name that does not fit
// is cut on grapheme boundaries (so wide and combined characters stay whole)
// and ends in `…` before the mark.
export function fitLabel(name: string, columns: number, blocked = false): string {
  const mark = blocked ? "!" : ""
  const full = `[ws:${name}${mark}]`
  if (Bun.stringWidth(full) <= columns) return full
  let prefix = ""
  for (const { segment } of graphemes(name)) {
    if (Bun.stringWidth(`[ws:${prefix}${segment}…${mark}]`) > columns) break
    prefix += segment
  }
  return `[ws:${prefix}…${mark}]`
}

// A third of the terminal width, clamped to the indicator's column limits.
export function labelBudget(columns: number): number {
  const third = Math.floor(columns / 3)
  return Math.min(INDICATOR_TIMING.maxColumns, Math.max(INDICATOR_TIMING.minColumns, third))
}

function graphemes(text: string) {
  return new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)
}
