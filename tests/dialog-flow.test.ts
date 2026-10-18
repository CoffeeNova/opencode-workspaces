import { expect, test } from "bun:test"
import type { Dialog, DialogSelectOptions } from "@opencode/plugin/tui/context"
import { checkDialogFlow } from "./fixtures/phase-zero-plugin/dialog-flow.ts"

function harness() {
  const selections: { options: DialogSelectOptions<string>; result: ReturnType<typeof Promise.withResolvers<string | undefined>> }[] = []
  const prompts: ReturnType<typeof Promise.withResolvers<string | undefined>>[] = []
  const alerts: unknown[] = []
  let current = true
  const dialog = {
    select: (options: DialogSelectOptions<string>) => {
      const result = Promise.withResolvers<string | undefined>()
      selections.push({ options, result })
      return result.promise
    },
    prompt: () => {
      // Reproduce the documented native semantics, not a bespoke question UI.
      selections.at(-1)!.result.resolve(undefined)
      const result = Promise.withResolvers<string | undefined>()
      prompts.push(result)
      return result.promise
    },
    alert: async (value: unknown) => { alerts.push(value) },
  } as unknown as Dialog
  return { selections, prompts, alerts, run: () => checkDialogFlow(dialog, () => current), dispose: () => { current = false } }
}

test("select replacement awaits its new prompt instead of cancelling the flow", async () => {
  const h = harness()
  const running = h.run()
  const action = h.selections[0]!.options.actions![0]!
  action.onTrigger("finish")
  action.onTrigger("finish")
  expect(h.prompts).toHaveLength(1)
  h.prompts[0]!.resolve("fixture label")
  await Promise.resolve()
  await Promise.resolve()
  expect(h.selections).toHaveLength(2)
  expect(h.selections[1]!.options.options[0]!.description).toBe("Label: fixture label")
  h.selections[1]!.result.resolve("finish")
  await running
  expect(h.alerts).toEqual([{ title: "Workspace probe: dialog flow complete", message: "Label: fixture label" }])
})

test("Escape in the replacement prompt cancels without a completion dialog", async () => {
  const h = harness()
  const running = h.run()
  h.selections[0]!.options.actions![0]!.onTrigger("finish")
  h.prompts[0]!.resolve(undefined)
  await running
  expect(h.selections).toHaveLength(1)
  expect(h.alerts).toEqual([])
})

test("an unloaded or changed view ignores a late replacement-prompt value", async () => {
  const h = harness()
  const running = h.run()
  h.selections[0]!.options.actions![0]!.onTrigger("finish")
  h.dispose()
  h.prompts[0]!.resolve("late")
  await running
  expect(h.selections).toHaveLength(1)
  expect(h.alerts).toEqual([])
})
