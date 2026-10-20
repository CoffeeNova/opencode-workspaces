import { Name, type Workspace } from "../../shared/schemas.ts"
import { CREATE_TEXT } from "../messages.ts"
import { addFolder } from "./add-folder.ts"
import type { MenuSession } from "./session.ts"
import { attachWorkspace } from "./switch.ts"

// Saving a definition never activates it; the follow-up choice is explicit.
export async function createWorkspace(menu: MenuSession): Promise<void> {
  const name = await menu.ui.dialog.prompt({ title: "Workspace name" })
  if (!menu.isValid() || name === undefined) return
  if (!Name.safeParse(name).success) {
    await menu.ui.dialog.alert({ title: "Invalid name", message: CREATE_TEXT.invalidName })
    return
  }
  const saved = await menu.change({ kind: "create", name })
  if (!saved) return
  const created = menu.state.workspaces.find((workspace) => workspace.name === name.trim())
  if (!created)
    throw new Error("The created workspace was not confirmed; reopen /workspace to reconcile")
  await offerNextStep(menu, created)
}

async function offerNextStep(menu: MenuSession, created: Workspace): Promise<void> {
  const next = await menu.ui.dialog.select({
    title: `Created ${created.name}`,
    options: [
      { title: "Add folder", value: "add" },
      { title: "Open / attach", value: "attach" },
      { title: "Done", value: "done" },
    ],
  })
  if (menu.isValid() && next === "add") {
    await addFolder(menu, created)
    return
  }
  if (menu.isValid() && next === "attach") await attachWorkspace(menu, created)
}
