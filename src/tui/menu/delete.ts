import { DELETE_TEXT } from "../messages.ts"
import type { MenuSession } from "./session.ts"

// Removes only the saved definition; sessions keep their pinned roots.
export async function deleteWorkspace(menu: MenuSession): Promise<void> {
  const workspace = await menu.choose()
  if (!workspace || !menu.isValid()) return
  const confirmed = await menu.ui.dialog.confirm({
    title: `Delete ${workspace.name}?`,
    message: DELETE_TEXT.confirm,
  })
  if (!confirmed || !menu.isValid()) return
  await menu.change({ kind: "remove", workspaceID: workspace.id })
}
