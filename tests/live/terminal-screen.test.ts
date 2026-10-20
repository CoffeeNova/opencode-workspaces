import { expect, test } from "bun:test"
import { terminalScreen } from "./terminal-screen.ts"
test("VT assertions see the current screen, not text erased by later frames", async () => {
  const screen = terminalScreen(40, 8)
  try {
    await screen.write("draft-before\r\nsecond line")
    expect(screen.text()).toContain("draft-before")
    await screen.write("\x1b[2J\x1b[Hdialog only")
    expect(screen.text()).not.toContain("draft-before")
    expect(screen.text()).toContain("dialog only")
    await screen.write("\x1b[2J\x1b[Hdraft-after")
    await screen.until(
      (view) => view.includes("draft-after") && !view.includes("dialog only"),
      "restored draft",
      1000,
    )
  } finally {
    await screen.dispose()
  }
})

test("VT input and cursor reports work across split ANSI frames", async () => {
  const replies: string[] = []
  const screen = terminalScreen(40, 8, (value) => {
    replies.push(value)
  })
  try {
    await screen.write("\x1b[3;")
    await screen.write("4Hdraft\x1b[6n")
    expect(screen.text().split("\n")[2]).toBe("   draft")
    expect(replies).toContain("\x1b[3;9R")
  } finally {
    await screen.dispose()
  }
})
