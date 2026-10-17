import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

// Only notification text is exposed, never file contents or permission replies.
export const WorkspaceNotifications = Rpc.define({
  id: "workspace-manager.notifications",
  methods: {},
  events: {
    toast: {
      schema: z.object({
        message: z.string(),
        variant: z.enum(["info", "success", "warning", "error"]),
      }),
    },
  },
})
