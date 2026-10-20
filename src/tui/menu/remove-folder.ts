import { REMOVE_FOLDER_TEXT } from "../messages.ts"
import type { MenuSession } from "./session.ts"

// Removes a saved folder registration; sessions and files are unchanged.
export async function removeFolder(menu: MenuSession): Promise<void> {
  const workspace = menu.currentDefinition()?.roots.length
    ? menu.currentDefinition()
    : await menu.choose(true)
  if (!workspace || !menu.isValid()) return
  const alias = await menu.ui.dialog.select({
    title: `Remove folder · ${workspace.name}`,
    options: workspace.roots.map((root) => ({
      title: root.alias,
      description: root.path,
      value: root.alias,
    })),
  })
  if (!menu.isValid() || !alias) return
  const confirmed = await menu.ui.dialog.confirm({
    title: `Remove ${alias}?`,
    message: REMOVE_FOLDER_TEXT.confirm,
  })
  if (!confirmed || !menu.isValid()) return
  await menu.change({ kind: "removeRoot", workspaceID: workspace.id, alias })
}
