import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const INHERITANCE_METADATA_KEY = "workspace-manager.capability-probe.inheritance"
export const InheritanceMarker = z.object({ catalogID: z.uuid(), token: z.uuid() }).strict()
const WaitInput = z.object({ sessionID: z.string().regex(/^ses/), timeoutMs: z.number().int().min(1).max(5000).default(50) }).strict()
const WaitOutput = z.object({ idle: z.boolean() }).strict()

// A disposable, metadata-only contract. This is not the workspace service API.
export const CapabilityProbe = Rpc.define({
  id: "workspace-manager.capability-probe",
  methods: {
    inspect: {
      input: z.object({ sessionID: z.string().regex(/^ses/).optional() }).strict(),
      output: z.object({
        instanceID: z.string(),
        runtimeVersion: z.string(),
        directory: z.string(),
        session: z.object({
          id: z.string(),
          parentID: z.string().optional(),
          forkSessionID: z.string().optional(),
          inheritance: z.discriminatedUnion("status", [
            z.object({ status: z.literal("absent") }),
            z.object({ status: z.literal("invalid") }),
            z.object({ status: z.literal("valid"), marker: InheritanceMarker }),
          ]),
        }).optional(),
      }).strict(),
      errors: {
        location_mismatch: z.object({ sessionID: z.string() }),
      },
    },
    waitIdle: {
      // Negative control: the Promise API's RequestOptions.signal is ignored on
      // the tested host, despite being present in its published TypeScript API.
      input: WaitInput,
      output: WaitOutput,
      errors: { location_mismatch: z.object({ sessionID: z.string() }) },
    },
  },
  events: {},
})

export const TuiObservation = z.object({
  instanceID: z.uuid(), event: z.enum(["setup", "cleanup", "command", "session-event"]),
  commandCopies: z.number().int().min(0).max(20),
  sessionID: z.string().regex(/^ses_[a-zA-Z0-9_-]{1,180}$/).optional(),
}).strict()
export type TuiEvent = z.infer<typeof TuiObservation>

// Bounded, synthetic test telemetry only. Never records composer/file content
// and never supplies session bindings, permissions, or authority to the TUI.
export const TuiProbe = Rpc.define({
  id: "workspace-manager.capability-probe.tui",
  methods: {
    record: { input: TuiObservation, output: z.object({}).strict() },
  },
  events: {},
})

export const BoundaryProbe = Rpc.define({
  id: "workspace-manager.capability-probe.boundary",
  methods: {
    status: {
      input: z.object({}).strict(),
      output: z.object({ epoch: z.number().int().nonnegative(), disposed: z.boolean() }).strict(),
    },
    advanceEpoch: {
      input: z.object({ sessionIDs: z.array(z.string().regex(/^ses/)).min(1).max(20), expectedEpoch: z.number().int().nonnegative() }).strict(),
      output: z.object({ epoch: z.number().int().nonnegative() }).strict(),
      errors: {
        location_mismatch: z.object({ sessionID: z.string() }),
        session_busy: z.object({}),
        revision_conflict: z.object({ epoch: z.number().int().nonnegative() }),
      },
    },
    waitIdle: {
      input: WaitInput,
      output: WaitOutput,
      errors: { location_mismatch: z.object({ sessionID: z.string() }) },
    },
  },
  events: {},
})
