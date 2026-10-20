import type { Workspace } from "../../shared/schemas.ts"
import type { MenuSession } from "./session.ts"

export async function openInNewSession(menu: MenuSession, workspace: Workspace): Promise<void> {
  if (!menu.isValid()) return
  // Explicit user action only. Keep a session if attach times out: it may
  // already be committed, and reopening must reconcile rather than retry.
  const created = await menu.context.client.session.create(
    { location: menu.target.location, title: `Workspace: ${workspace.name}` },
    { signal: menu.signal },
  )
  const attached = await menu.change({ kind: "attach", workspaceID: workspace.id }, created.id)
  if (!attached) return
  if (menu.state.binding?.workspace?.id !== workspace.id)
    throw new Error(
      "The created session's binding was not confirmed; reopen /workspace to reconcile",
    )
  if (menu.isValid()) menu.ui.router.navigate({ type: "session", sessionID: created.id })
}

export async function openOrdinarySession(menu: MenuSession): Promise<void> {
  if (!menu.isValid()) return
  const created = await menu.context.client.session.create(
    { location: menu.target.location },
    { signal: menu.signal },
  )
  if (menu.isValid()) menu.ui.router.navigate({ type: "session", sessionID: created.id })
}

// A session that has not started detaches in place; otherwise it stays pinned.
export async function detach(menu: MenuSession): Promise<void> {
  if (menu.state.canAttach) {
    await menu.change({ kind: "detach" })
    return
  }
  await openOrdinarySession(menu)
}
