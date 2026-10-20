import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { errorText, unreachable } from "../../shared/errors.ts"
import type { State } from "../../shared/schemas.ts"
import { MAIN_MENU_TEXT } from "../messages.ts"
import { addToSavedWorkspace } from "./add-folder.ts"
import { createWorkspace } from "./create.ts"
import { deleteWorkspace } from "./delete.ts"
import { detach } from "./open-session.ts"
import { removeFolder } from "./remove-folder.ts"
import type { MenuSession } from "./session.ts"
import { showStatus } from "./status.ts"
import { switchWorkspace } from "./switch.ts"

export type MenuEntry = "main" | "add" | "switch"

type MenuAction = "switch" | "create" | "add" | "root" | "status" | "detach" | "delete"

export async function runMenu(menu: MenuSession, entry: MenuEntry): Promise<void> {
  try {
    if (!(await menu.refresh())) return
    await openEntry(menu, entry)
  } catch (error) {
    if (menu.isValid())
      await menu.ui.dialog.alert({
        title: "Workspace action stopped",
        message: `${errorText(error)}\n${MAIN_MENU_TEXT.stoppedHint}`,
      })
  }
}

async function openEntry(menu: MenuSession, entry: MenuEntry): Promise<void> {
  switch (entry) {
    case "switch":
      return switchWorkspace(menu)
    case "add":
      return addToSavedWorkspace(menu)
    case "main":
      return mainLoop(menu)
    default:
      unreachable(entry)
  }
}

async function mainLoop(menu: MenuSession): Promise<void> {
  while (menu.isValid()) {
    if (!(await menu.refresh())) return
    const action = await menu.ui.dialog.select<MenuAction>({
      title: `Workspace · ${menu.state.binding?.workspace?.name ?? "none selected"}`,
      placeholder: menuPlaceholder(menu.state),
      options: menuOptions(menu.state),
    })
    if (!menu.isValid() || !action) return
    const keepOpen = await runAction(menu, action)
    if (!keepOpen) return
  }
}

// Runs one chosen action. Returns false only when the menu must stop at once.
async function runAction(menu: MenuSession, action: MenuAction): Promise<boolean> {
  switch (action) {
    case "create":
      await createWorkspace(menu)
      return true
    case "status":
      return showStatus(menu)
    case "detach":
      await detach(menu)
      return true
    case "switch":
      await switchWorkspace(menu)
      return true
    case "add":
      await addToSavedWorkspace(menu)
      return true
    case "delete":
      await deleteWorkspace(menu)
      return true
    case "root":
      await removeFolder(menu)
      return true
    default:
      return unreachable(action)
  }
}

function menuPlaceholder(state: State): string {
  const active = state.binding?.workspace
  if (!active) return MAIN_MENU_TEXT.noneSelected
  const fixed = state.canAttach ? "" : " · fixed for this session"
  return `${active.roots.length} folders${fixed}`
}

function menuOptions(state: State): DialogSelectOption<MenuAction>[] {
  const hasSaved = state.workspaces.length > 0
  const hasFolders = state.workspaces.some((workspace) => workspace.roots.length > 0)
  const options: DialogSelectOption<MenuAction>[] = []
  if (hasSaved) options.push({ title: "Switch / open workspace", value: "switch" })
  options.push({ title: "Create workspace", value: "create" })
  if (hasSaved) options.push({ title: "Add folder to saved workspace", value: "add" })
  if (hasFolders) options.push({ title: "Remove folder registration", value: "root" })
  options.push({ title: "Show status", value: "status" })
  if (state.binding?.workspace) options.push({ title: detachTitle(state), value: "detach" })
  if (hasSaved)
    options.push({
      title: "Delete saved definition",
      value: "delete",
      category: "Saved definitions",
    })
  return options
}

function detachTitle(state: State): string {
  if (state.canAttach) return "Detach from this empty session"
  return "Open new ordinary session (detach)"
}
