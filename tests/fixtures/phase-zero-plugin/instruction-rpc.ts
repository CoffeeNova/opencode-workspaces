import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

// Fixture setup only: no arbitrary roots, file bodies, binding persistence, or
// journal authority. Activation is restricted to a new, empty native session.
export const InstructionProbe = Rpc.define({
  id: "workspace-manager.capability-probe.instructions",
  methods: {
    activate: {
      input: z.object({ sessionID: z.string().regex(/^ses/), roots: z.enum(["both", "a", "overlap"]).default("both") }).strict(),
      output: z.object({}).strict(),
      errors: { invalid_fixture_session: z.object({ sessionID: z.string() }) },
    },
  },
  events: {},
})
