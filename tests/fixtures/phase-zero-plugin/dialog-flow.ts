import type { Dialog } from "@opencode/plugin/tui/context"

// Test-only native-widget flow. In particular, a footer action replacing a
// select resolves that select with undefined; it must not cancel the new prompt.
export async function checkDialogFlow(dialog: Dialog, current: () => boolean) {
  let label = "not set"
  while (current()) {
    const transition: { prompt?: Promise<string | undefined> } = {}
    const action = await dialog.select({
      title: "Workspace dialog flow",
      options: [{ title: "Finish dialog check", value: "finish", description: `Label: ${label}` }],
      actions: [{
        bind: "ctrl+o", title: "Change label", selection: "none",
        onTrigger: () => {
          if (!current() || transition.prompt) return
          transition.prompt = dialog.prompt({ title: "Workspace probe label", value: label === "not set" ? "" : label })
        },
      }],
    })
    if (transition.prompt) {
      const value = await transition.prompt
      if (!current() || value === undefined) return
      label = value
      continue
    }
    if (!current() || action !== "finish") return
    await dialog.alert({ title: "Workspace probe: dialog flow complete", message: `Label: ${label}` })
    return
  }
}
