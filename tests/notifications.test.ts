import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/plugin"
import Notifications from "../.opencode/plugins/workspace-manager-notifications/tui.ts"

test("the V2 TUI companion only shows native toasts for its current Location and cleans up its listener", async () => {
  type Event = { location: { directory: string }; data: { message: string; variant: "success" } }
  let listener: ((event: Event) => void) | undefined
  let stopped = false
  const toasts: unknown[] = []
  const context = {
    location: { directory: "C:/data/project" },
    client: { rpc: () => ({ events: { on: (_name: string, callback: (event: Event) => void) => {
      listener = callback
      return () => { stopped = true }
    } } }) },
    ui: { toast: { show: (input: unknown) => { toasts.push(input) } } },
  } as unknown as Context
  const cleanup = await Notifications.setup(context)
  listener!({ location: { directory: "C:/data/other-project" }, data: { message: "not ours", variant: "success" } })
  expect(toasts).toEqual([])
  listener!({ location: { directory: "C:/data/project" }, data: { message: "workspace saved", variant: "success" } })
  expect(toasts).toEqual([{ title: "workspace-manager", message: "workspace saved", variant: "success", duration: 4500 }])
  if (typeof cleanup !== "function") throw new Error("Expected an unsubscribe callback")
  await cleanup()
  expect(stopped).toBe(true)
})
