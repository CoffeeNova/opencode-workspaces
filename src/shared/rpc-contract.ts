import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { BrowsePage, ChangedEvent, Change, Selection, SessionID, State } from "./schemas.ts"

const errors = { workspace: z.object({ code: z.string() }).strict() }

export const WorkspaceRPC = Rpc.define({
  id: "workspace-manager.v2",
  methods: {
    state: {
      input: z.object({ sessionID: SessionID.optional() }).strict(),
      output: State,
      errors,
    },
    selection: {
      input: z.object({ sessionID: SessionID }).strict(),
      output: Selection,
      errors,
    },
    change: { input: Change, output: State, errors },
    browse: {
      input: z.object({ path: z.string().optional() }).strict(),
      output: BrowsePage,
      errors,
    },
  },
  events: {
    changed: { schema: ChangedEvent },
  },
})
