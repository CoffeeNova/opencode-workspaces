import type { Context } from "@opencode/plugin/tui/context"
import { WorkspaceRPC } from "../shared/rpc-contract.ts"

// The typed workspace RPC client shared by the menu and the footer indicator.
export function workspaceClient(context: Context) {
  return context.client.rpc(WorkspaceRPC)
}

export type WorkspaceClient = ReturnType<typeof workspaceClient>
