import type { Context } from "@opencode/plugin/tui/context"
import { WorkspaceRPC } from "../../shared/rpc-contract.ts"
import type { Action, State, Workspace } from "../../shared/schemas.ts"
import { CHOOSE_TEXT } from "../messages.ts"
import { currentTarget, isSameTarget, type MenuTarget } from "../target.ts"

export function workspaceClient(context: Context) {
  return context.client.rpc(WorkspaceRPC)
}

export type WorkspaceClient = ReturnType<typeof workspaceClient>

type Indicator = { refresh(): void }

// One open menu: its pinned target, the last loaded state, and the guarded mutation.
export class MenuSession {
  readonly rpcOptions: { location: MenuTarget["location"]; signal: AbortSignal }
  private loaded: State | undefined

  constructor(
    readonly context: Context,
    readonly rpc: WorkspaceClient,
    private readonly indicator: Indicator,
    readonly target: MenuTarget,
    readonly signal: AbortSignal,
  ) {
    this.rpcOptions = { location: target.location, signal }
  }

  get ui() {
    return this.context.ui
  }

  get state(): State {
    if (!this.loaded) throw new Error("Workspace state is not loaded; reopen /workspace")
    return this.loaded
  }

  // False once the plugin unloads or the user navigates to another session or Location.
  isValid(): boolean {
    if (this.signal.aborted) return false
    try {
      return isSameTarget(currentTarget(this.context), this.target)
    } catch {
      return false
    }
  }

  async refresh(): Promise<boolean> {
    const input = this.target.sessionID ? { sessionID: this.target.sessionID } : {}
    this.loaded = await this.rpc.state(input, this.rpcOptions)
    return this.isValid()
  }

  async change(action: Action, sessionID = this.target.sessionID): Promise<boolean> {
    if (!this.isValid()) return false
    this.loaded = await this.rpc.change(
      {
        requestID: crypto.randomUUID(),
        expectedRevision: this.state.revision,
        ...(sessionID ? { sessionID } : {}),
        action,
      },
      this.rpcOptions,
    )
    this.indicator.refresh()
    // Feedback is independent of a committed result: never retry a mutation
    // because a toast failed. Transport failures are reconciled by reopening.
    try {
      this.ui.toast.show({ message: "Workspace saved", variant: "success" })
    } catch {}
    return this.isValid()
  }

  currentDefinition(): Workspace | undefined {
    return this.state.workspaces.find(
      (workspace) => workspace.id === this.state.binding?.workspace?.id,
    )
  }

  async choose(requireFolders = false): Promise<Workspace | undefined> {
    if (!(await this.refresh())) return
    const choices = this.state.workspaces.filter(
      (workspace) => !requireFolders || workspace.roots.length > 0,
    )
    if (!choices.length) {
      await this.ui.dialog.alert({
        title: "No saved workspaces",
        message: requireFolders ? CHOOSE_TEXT.noFoldersToRemove : CHOOSE_TEXT.createFirst,
      })
      return
    }
    const id = await this.ui.dialog.select({
      title: "Saved workspaces",
      current: this.state.binding?.workspace?.id,
      options: choices.map((workspace) => ({
        title: workspace.name,
        description: `${workspace.roots.length} folders`,
        value: workspace.id,
      })),
    })
    if (!this.isValid()) return
    return this.state.workspaces.find((workspace) => workspace.id === id)
  }
}
