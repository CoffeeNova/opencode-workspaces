import { errorText } from "../../shared/errors.ts"
import { Alias, type BrowsePage, type Workspace } from "../../shared/schemas.ts"
import { ADD_FOLDER_TEXT } from "../messages.ts"
import { openInNewSession } from "./open-session.ts"
import type { MenuSession } from "./session.ts"

// Adds to the displayed session's workspace, or asks which saved one to extend.
export async function addToSavedWorkspace(menu: MenuSession): Promise<void> {
  const workspace = menu.currentDefinition() ?? (await menu.choose())
  if (workspace && menu.isValid()) await addFolder(menu, workspace)
}

// Browses server folders until one is added or the user stops. Each step
// returns the next folder to browse, or undefined to stop.
export async function addFolder(menu: MenuSession, workspace: Workspace): Promise<void> {
  let current: string | undefined
  while (menu.isValid()) {
    const next = await browseStep(menu, workspace, current)
    if (next === undefined) return
    current = next
  }
}

async function browseStep(
  menu: MenuSession,
  workspace: Workspace,
  current: string | undefined,
): Promise<string | undefined> {
  let page: BrowsePage
  try {
    page = await menu.rpc.browse(current ? { path: current } : {}, menu.rpcOptions)
  } catch (error) {
    return correctPath(menu, current, error)
  }
  if (!menu.isValid()) return
  const picked = await pickFolder(menu, workspace, page)
  if (!menu.isValid() || !picked) return
  if (picked === "paste") return pastePath(menu, page)
  if (picked === "add") return registerFolder(menu, workspace, page)
  return picked
}

async function correctPath(
  menu: MenuSession,
  current: string | undefined,
  error: unknown,
): Promise<string | undefined> {
  if (!menu.isValid()) return
  await menu.ui.dialog.alert({ title: "Folder unavailable", message: errorText(error) })
  if (!menu.isValid()) return
  const corrected = await menu.ui.dialog.prompt({
    title: "Server folder path",
    ...(current ? { value: current } : {}),
  })
  if (!menu.isValid() || corrected === undefined) return
  return corrected
}

function pickFolder(menu: MenuSession, workspace: Workspace, page: BrowsePage) {
  return menu.ui.dialog.select({
    title: `Add folder · ${workspace.name}`,
    placeholder: page.current,
    options: [
      {
        title: "Add current folder",
        description: ADD_FOLDER_TEXT.addCurrentFolder,
        value: "add",
      },
      { title: "Paste path manually", value: "paste" },
      ...(page.parent ? [{ title: "..", value: page.parent }] : []),
      ...page.directories.map((directory) => ({
        title: `${directory.name}/`,
        value: directory.path,
      })),
    ],
  })
}

async function pastePath(menu: MenuSession, page: BrowsePage): Promise<string | undefined> {
  const entered = await menu.ui.dialog.prompt({
    title: "Server folder path",
    placeholder: page.current,
    description: ADD_FOLDER_TEXT.pastePath,
  })
  if (!menu.isValid() || entered === undefined) return
  return entered
}

// Returns the folder to browse again after an invalid alias; otherwise stops.
async function registerFolder(
  menu: MenuSession,
  workspace: Workspace,
  page: BrowsePage,
): Promise<string | undefined> {
  if (workspace.roots.some((root) => root.path === page.current)) {
    await menu.ui.dialog.alert({ title: "Already added", message: ADD_FOLDER_TEXT.alreadyAdded })
    return
  }
  const alias = await menu.ui.dialog.prompt({
    title: "Folder alias",
    value: page.suggestedAlias,
    description: ADD_FOLDER_TEXT.alias,
  })
  if (!menu.isValid() || alias === undefined) return
  if (!Alias.safeParse(alias).success) {
    await menu.ui.dialog.alert({ title: "Invalid alias", message: ADD_FOLDER_TEXT.invalidAlias })
    return page.current
  }
  await menu.change({ kind: "addRoot", workspaceID: workspace.id, path: page.current, alias })
  if (!menu.isValid()) return
  await offerSavedFolder(menu, workspace)
  return
}

// Saved edits never retarget the displayed session unless the user applies them.
async function offerSavedFolder(menu: MenuSession, workspace: Workspace): Promise<void> {
  const updated = menu.state.workspaces.find((item) => item.id === workspace.id)
  if (!updated) throw new Error("The saved workspace was removed; reopen /workspace to reconcile")
  if (!menu.target.sessionID || menu.state.binding?.workspace?.id !== workspace.id) return
  const next = await menu.ui.dialog.select({
    title: "Folder saved",
    placeholder: ADD_FOLDER_TEXT.folderSaved,
    options: [
      {
        title: menu.state.canAttach
          ? "Use updated folders in this empty session"
          : "Open updated workspace in new session",
        value: "apply",
      },
      { title: "Keep current session unchanged", value: "keep" },
    ],
  })
  if (!menu.isValid() || next !== "apply") return
  if (menu.state.canAttach) {
    await menu.change({ kind: "attach", workspaceID: updated.id })
    return
  }
  await openInNewSession(menu, updated)
}
