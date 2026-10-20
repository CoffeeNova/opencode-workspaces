import type { Selection, Workspace } from "../../shared/schemas.ts"
import { STATUS_TEXT, savedRevisionText } from "../messages.ts"
import type { MenuSession } from "./session.ts"

// Shows passive status without changing anything. Returns false when the
// target changed while loading, so the main menu stops at once.
export async function showStatus(menu: MenuSession): Promise<boolean> {
  const sessionID = menu.target.sessionID
  const selection = sessionID ? await menu.rpc.selection({ sessionID }, menu.rpcOptions) : undefined
  if (!menu.isValid()) return false
  await menu.ui.dialog.alert({ title: "Workspace status", message: statusMessage(menu, selection) })
  return true
}

function statusMessage(menu: MenuSession, selection: Selection | undefined): string {
  const active = menu.state.binding?.workspace
  if (!active) return STATUS_TEXT.noneSelected
  const roots = active.roots.map((root) => `${root.alias}:/ → ${root.path}`).join("\n")
  const editing = menu.state.canAttach ? STATUS_TEXT.selectionEditable : STATUS_TEXT.selectionFixed
  const update = savedDefinitionNote(active, menu.currentDefinition())
  const instructions = instructionsText(selection)
  return `${active.name} · pinned revision ${active.revision}\n${roots || "No folders"}\n\n${editing}${update}\nInstructions: ${instructions}`
}

function savedDefinitionNote(active: Workspace, saved: Workspace | undefined): string {
  if (!saved) return `\n${STATUS_TEXT.savedDeleted}`
  if (saved.revision !== active.revision)
    return `\n${savedRevisionText(saved.revision, active.revision)}`
  return ""
}

function instructionsText(selection: Selection | undefined): string {
  if (selection?.instructions === "ready") return STATUS_TEXT.instructionsReady
  if (selection?.instructions === "blocked") return STATUS_TEXT.instructionsBlocked
  return STATUS_TEXT.instructionsNotLoaded
}
