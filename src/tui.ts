import { Plugin } from "@opencode/plugin/tui"
import { Alias, Name, type Action, type State, type Workspace } from "./domain.ts"
import { WorkspaceRPC } from "./rpc.ts"
import { registerWorkspaceIndicator } from "./tui/indicator.ts"

function errorText(error: unknown) { return error && typeof error === "object" && "message" in error ? String(error.message) : String(error) }

export default Plugin.define({
  id: "workspace-manager.v2.tui",
  setup(context) {
    const rpc = context.client.rpc(WorkspaceRPC)
    const lifetime = new AbortController()
    const indicator = registerWorkspaceIndicator(context)
    let running = false
    function target() {
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const location = sessionID ? context.data.session.get(sessionID)?.location : context.location ?? context.data.location.default()
      if (!location?.directory) throw new Error("Session metadata is loading; reopen Workspace shortly")
      return { sessionID, location }
    }
    async function open(entry: "main" | "add" | "switch") {
      if (running || lifetime.signal.aborted) return
      let selected: ReturnType<typeof target>
      try { selected = target() } catch (error) {
        await context.ui.dialog.alert({ title: "Workspace unavailable", message: errorText(error) })
        return
      }
      running = true
      const valid = () => {
        if (lifetime.signal.aborted) return false
        try {
          const now = target()
          return now.sessionID === selected.sessionID && now.location.directory === selected.location.directory
        } catch { return false }
      }
      const options = { location: selected.location, signal: lifetime.signal }
      let state!: State
      async function refresh() { state = await rpc.state(selected.sessionID ? { sessionID: selected.sessionID } : {}, options); return valid() }
      async function change(action: Action, sessionID = selected.sessionID) {
        if (!valid()) return false
        state = await rpc.change({ requestID: crypto.randomUUID(), expectedRevision: state.revision, ...(sessionID ? { sessionID } : {}), action }, options)
        indicator.refresh()
        // Feedback is independent of a committed result: never retry a mutation
        // because a toast failed. Transport failures are reconciled by reopening.
        try { context.ui.toast.show({ message: "Workspace saved", variant: "success" }) } catch {}
        return valid()
      }
      function currentDefinition() { return state.workspaces.find((workspace) => workspace.id === state.binding?.workspace?.id) }
      async function choose(requireFolders = false): Promise<Workspace | undefined> {
        if (!await refresh()) return
        const choices = state.workspaces.filter((workspace) => !requireFolders || workspace.roots.length > 0)
        if (!choices.length) {
          await context.ui.dialog.alert({ title: "No saved workspaces", message: requireFolders ? "No saved workspace has folders to remove." : "Create a workspace first, then add folders." })
          return
        }
        const id = await context.ui.dialog.select({ title: "Saved workspaces", current: state.binding?.workspace?.id, options: choices.map((workspace) => ({ title: workspace.name, description: `${workspace.roots.length} folders`, value: workspace.id })) })
        return valid() ? state.workspaces.find((workspace) => workspace.id === id) : undefined
      }
      async function openNew(workspace: Workspace) {
        if (!valid()) return
        // Explicit user action only. Keep a session if attach times out: it may
        // already be committed, and reopening must reconcile rather than retry.
        const created = await context.client.session.create({ location: selected.location, title: `Workspace: ${workspace.name}` }, { signal: lifetime.signal })
        if (!await change({ kind: "attach", workspaceID: workspace.id }, created.id)) return
        if (state.binding?.workspace?.id !== workspace.id) throw new Error("The created session's binding was not confirmed; reopen /workspace to reconcile")
        if (valid()) context.ui.router.navigate({ type: "session", sessionID: created.id })
      }
      async function openOrdinary() {
        if (!valid()) return
        const created = await context.client.session.create({ location: selected.location }, { signal: lifetime.signal })
        if (valid()) context.ui.router.navigate({ type: "session", sessionID: created.id })
      }
      async function attach(workspace: Workspace) {
        if (!valid()) return
        const message = selected.sessionID && !state.canAttach ? "This session has started or cannot be safely attached. Its context stays unchanged; open the saved workspace in a new empty session." : "Explicitly select this workspace in an empty session. No prompt will be sent."
        const action = await context.ui.dialog.select({ title: workspace.name, placeholder: message, options: [
          ...(selected.sessionID && state.canAttach ? [{ title: "Use in this empty session", value: "here" }] : []),
          { title: "Open in new session", value: "new" },
        ] })
        if (!valid() || !action) return
        if (action === "here") { await change({ kind: "attach", workspaceID: workspace.id }); return }
        await openNew(workspace)
      }
      async function add(workspace: Workspace) {
        let current: string | undefined
        while (valid()) {
          let page: Awaited<ReturnType<typeof rpc.browse>>
          try { page = await rpc.browse(current ? { path: current } : {}, options) } catch (error) {
            if (!valid()) return
            await context.ui.dialog.alert({ title: "Folder unavailable", message: errorText(error) })
            if (!valid()) return
            const corrected = await context.ui.dialog.prompt({ title: "Server folder path", ...(current ? { value: current } : {}) })
            if (!valid() || corrected === undefined) return
            current = corrected
            continue
          }
          if (!valid()) return
          const picked = await context.ui.dialog.select({ title: `Add folder · ${workspace.name}`, placeholder: page.current, options: [
            { title: "Add current folder", description: "Its AGENTS.md may guide the agent; this is not tool approval", value: "add" },
            { title: "Paste path manually", value: "paste" },
            ...(page.parent ? [{ title: "..", value: page.parent }] : []),
            ...page.directories.map((directory) => ({ title: `${directory.name}/`, value: directory.path })),
          ] })
          if (!valid() || !picked) return
          if (picked === "paste") {
            const entered = await context.ui.dialog.prompt({ title: "Server folder path", placeholder: page.current, description: "Server filesystem; supports spaces, ~ and $HOME. Browsing does not add a folder." })
            if (!valid() || entered === undefined) return
            current = entered
          } else if (picked === "add") {
            if (workspace.roots.some((root) => root.path === page.current)) {
              await context.ui.dialog.alert({ title: "Already added", message: "This canonical folder is already registered in the saved workspace." })
              return
            }
            const alias = await context.ui.dialog.prompt({ title: "Folder alias", value: page.suggestedAlias, description: "Lowercase letters, digits, - or _. Saved edits do not retarget existing sessions." })
            if (!valid() || alias === undefined) return
            if (!Alias.safeParse(alias).success) {
              await context.ui.dialog.alert({ title: "Invalid alias", message: "Use lowercase letters, digits, - or _. The folder path has been preserved." })
              current = page.current
              continue
            }
            await change({ kind: "addRoot", workspaceID: workspace.id, path: page.current, alias })
            if (!valid()) return
            const updated = state.workspaces.find((item) => item.id === workspace.id)!
            if (selected.sessionID && state.binding?.workspace?.id === workspace.id) {
              const next = await context.ui.dialog.select({ title: "Folder saved", placeholder: "Existing session roots are unchanged until you explicitly apply the saved definition.", options: [
                { title: state.canAttach ? "Use updated folders in this empty session" : "Open updated workspace in new session", value: "apply" },
                { title: "Keep current session unchanged", value: "keep" },
              ] })
              if (!valid() || next !== "apply") return
              if (state.canAttach) await change({ kind: "attach", workspaceID: updated.id })
              else await openNew(updated)
            }
            return
          } else current = picked
        }
      }
      try {
        if (!await refresh()) return
        if (entry === "switch") { const workspace = await choose(); if (workspace) await attach(workspace); return }
        if (entry === "add") { const workspace = currentDefinition() ?? await choose(); if (workspace) await add(workspace); return }
        while (valid()) {
          if (!await refresh()) return
          const active = state.binding?.workspace
          const selectedAction = await context.ui.dialog.select({ title: `Workspace · ${active?.name ?? "none selected"}`, placeholder: active ? `${active.roots.length} folders${!state.canAttach ? " · fixed for this session" : ""}` : "Manage saved definitions; only explicit selection activates a workspace.", options: [
            ...(state.workspaces.length ? [{ title: "Switch / open workspace", value: "switch" }] : []),
            { title: "Create workspace", value: "create" },
            ...(state.workspaces.length ? [{ title: "Add folder to saved workspace", value: "add" }] : []),
            ...(state.workspaces.some((workspace) => workspace.roots.length) ? [{ title: "Remove folder registration", value: "root" }] : []),
            { title: "Show status", value: "status" },
            ...(active ? [{ title: state.canAttach ? "Detach from this empty session" : "Open new ordinary session (detach)", value: "detach" }] : []),
            ...(state.workspaces.length ? [{ title: "Delete saved definition", value: "delete", category: "Saved definitions" }] : []),
          ] })
          if (!valid() || !selectedAction) return
          if (selectedAction === "create") {
            const name = await context.ui.dialog.prompt({ title: "Workspace name" })
            if (!valid() || name === undefined) continue
            if (!Name.safeParse(name).success) {
              await context.ui.dialog.alert({ title: "Invalid name", message: "Use a printable name of 1–100 characters, without reserved object-property names." })
              continue
            }
            if (await change({ kind: "create", name })) {
              const created = state.workspaces.find((workspace) => workspace.name === name.trim())!
              const next = await context.ui.dialog.select({ title: `Created ${created.name}`, options: [{ title: "Add folder", value: "add" }, { title: "Open / attach", value: "attach" }, { title: "Done", value: "done" }] })
              if (valid() && next === "add") await add(created)
              else if (valid() && next === "attach") await attach(created)
            }
          } else if (selectedAction === "status") {
            const selection = selected.sessionID ? await rpc.selection({ sessionID: selected.sessionID }, options) : undefined
            if (!valid()) return
            const instructions = selection?.instructions === "ready" ? "Ready at the last model request." : selection?.instructions === "blocked" ? "Blocked at the last request; check source/budget or permission errors." : "Not loaded yet; the next request uses session permissions."
            const saved = currentDefinition()
            const update = active && saved && saved.revision !== active.revision ? `\nSaved definition is revision ${saved.revision}; this session retains revision ${active.revision}.` : active && !saved ? "\nSaved definition was deleted; this session retains its pinned folders." : ""
            await context.ui.dialog.alert({ title: "Workspace status", message: active ? `${active.name} · pinned revision ${active.revision}\n${active.roots.map((root) => `${root.alias}:/ → ${root.path}`).join("\n") || "No folders"}\n\n${!state.canAttach ? "Selection is fixed. Switch or apply saved changes in a new session." : "Saved changes can be applied before starting work."}${update}\nInstructions: ${instructions}` : "No workspace selected. Native OpenCode behavior remains unchanged. Creating or editing a saved definition does not activate it; explicitly select one in an empty or new session." })
          } else if (selectedAction === "detach") {
            if (state.canAttach) await change({ kind: "detach" })
            else await openOrdinary()
          }
          else {
            const workspace = selectedAction === "add" ? currentDefinition() ?? await choose()
              : selectedAction === "root" ? (currentDefinition()?.roots.length ? currentDefinition() : await choose(true))
              : await choose()
            if (!workspace || !valid()) continue
            if (selectedAction === "switch") await attach(workspace)
            else if (selectedAction === "add") await add(workspace)
            else if (selectedAction === "delete") {
              if (await context.ui.dialog.confirm({ title: `Delete ${workspace.name}?`, message: "Only the saved definition is removed. Existing sessions retain their pinned roots. No files are deleted." }) && valid()) await change({ kind: "remove", workspaceID: workspace.id })
            } else if (selectedAction === "root") {
              const alias = await context.ui.dialog.select({ title: `Remove folder · ${workspace.name}`, options: workspace.roots.map((root) => ({ title: root.alias, description: root.path, value: root.alias })) })
              if (valid() && alias && await context.ui.dialog.confirm({ title: `Remove ${alias}?`, message: "Remove this saved folder registration only. Existing sessions and files are unchanged." }) && valid()) await change({ kind: "removeRoot", workspaceID: workspace.id, alias })
            }
          }
        }
      } catch (error) {
        if (valid()) await context.ui.dialog.alert({ title: "Workspace action stopped", message: `${errorText(error)}\nReopen the menu to reconcile saved state; do not blindly repeat a timed-out mutation.` })
      } finally { running = false }
    }
    context.keymap.layer(() => ({ mode: "global", commands: ([
      ["workspace", "main", "Manage workspaces"], ["workspace-add", "add", "Add workspace folder"], ["workspace-switch", "switch", "Switch workspace"],
    ] as const).map(([name, entry, title]) => ({ id: `workspace-manager.${name}`, title, group: "Workspace", slash: { name }, palette: true, run: () => open(entry) })) }))
    return () => { lifetime.abort(); indicator.dispose() }
  },
})
