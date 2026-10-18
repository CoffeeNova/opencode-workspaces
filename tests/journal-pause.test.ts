import { expect, test } from "bun:test"
import { journalPauses } from "./fixtures/phase-zero-plugin/journal-pause.ts"

test("publication pauses are one-shot, explicitly released, and do not pause other stages", async () => {
  const pauses = journalPauses()
  const hold = pauses.arm("request", "metadata-read")
  const signal = new AbortController().signal
  try {
    await hold.at("prepared", signal)
    expect(pauses.status()).toEqual({ pause: null })
    const waiting = hold.at("metadata-read", signal)
    expect(pauses.status()).toEqual({ pause: { requestID: "request", stage: "metadata-read" } })
    expect(() => pauses.release("other")).toThrow("No matching")
    expect(() => pauses.arm("other", "prepared")).toThrow("already paused")
    pauses.release("request")
    await waiting
  } finally { hold.dispose() }
  expect(pauses.status()).toEqual({ pause: null })
  expect(() => pauses.release("request")).toThrow("No matching")
})

test("cancellation releases the test pause without leaving a blocked publisher", async () => {
  const pauses = journalPauses()
  const hold = pauses.arm("request", "prepared")
  const controller = new AbortController()
  try {
    const waiting = hold.at("prepared", controller.signal)
    controller.abort(new Error("Fixture cancelled"))
    await expect(waiting).rejects.toThrow("Fixture cancelled")
  } finally { hold.dispose() }
  const next = pauses.arm("next", "prepared")
  next.dispose()
  expect(pauses.status()).toEqual({ pause: null })
})
