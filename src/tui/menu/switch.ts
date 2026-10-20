import type { Workspace } from "../../shared/schemas.ts"
import { ATTACH_TEXT } from "../messages.ts"
import { openInNewSession } from "./open-session.ts"
import type { MenuSession } from "./session.ts"

export async function switchWorkspace(menu: MenuSession): Promise<void> {
  const workspace = await menu.choose()
  if (workspace && menu.isValid()) await attachWorkspace(menu, workspace)
}

// Only an empty displayed session can take the workspace in place.
export async function attachWorkspace(menu: MenuSession, workspace: Workspace): Promise<void> {
  if (!menu.isValid()) return
  const sessionID = menu.target.sessionID
  const message =
    sessionID && !menu.state.canAttach ? ATTACH_TEXT.cannotAttach : ATTACH_TEXT.explicitSelection
  const action = await menu.ui.dialog.select({
    title: workspace.name,
    placeholder: message,
    options: [
      ...(sessionID && menu.state.canAttach
        ? [{ title: "Use in this empty session", value: "here" }]
        : []),
      { title: "Open in new session", value: "new" },
    ],
  })
  if (!menu.isValid() || !action) return
  if (action === "here") {
    await menu.change({ kind: "attach", workspaceID: workspace.id })
    return
  }
  await openInNewSession(menu, workspace)
}
