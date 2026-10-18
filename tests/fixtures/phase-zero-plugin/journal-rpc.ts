import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

// Shared probe contract: no filesystem/host side effects or metadata contents.
export const JournalSessionID = z.string().regex(/^ses_[a-zA-Z0-9_-]{1,180}$/)
export const JournalRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const JournalMarker = z.object({ catalogID: z.uuid(), token: z.uuid() }).strict()
export const JournalStage = z.enum(["prepared", "publishing", "mirror"])
const PauseStage = z.enum(["prepared", "metadata-read"])
export const JournalRequest = z.object({
  requestID: z.uuid(), sessionID: JournalSessionID, workspaceID: z.uuid().nullable(), expectedRevision: JournalRevision,
}).strict()
const Phase = z.enum(["prepared", "publishing", "committed", "aborted"])
const Result = z.object({ requestID: z.uuid(), phase: Phase, workspaceID: z.uuid().nullable(), revision: JournalRevision }).strict()
const errors = { journal_error: z.object({ code: z.string(), message: z.string() }).strict() }

export const JournalProbe = Rpc.define({
  id: "workspace-manager.capability-probe.journal",
  methods: {
    status: {
      input: z.object({}).strict(),
      output: z.object({
        catalogID: z.uuid(), revision: JournalRevision, workspaceIDs: z.array(z.uuid()),
        bindings: z.array(z.object({ sessionID: JournalSessionID, workspaceID: z.uuid().nullable() }).strict()),
        operations: z.array(z.object({ requestID: z.uuid(), sessionID: JournalSessionID, phase: Phase }).strict()),
      }).strict(), errors,
    },
    change: { input: JournalRequest.extend({ interruptAfter: JournalStage.optional(), pauseAfter: PauseStage.optional() }).strict(), output: Result, errors },
    recover: { input: z.object({ requestID: z.uuid() }).strict(), output: Result, errors },
    resolve: { input: z.object({ sessionID: JournalSessionID }).strict(), output: z.object({ workspaceID: z.uuid().nullable() }).strict(), errors },
    paused: { input: z.object({}).strict(), output: z.object({ pause: z.object({ requestID: z.uuid(), stage: PauseStage }).strict().nullable() }).strict(), errors },
    release: { input: z.object({ requestID: z.uuid() }).strict(), output: z.object({}).strict(), errors },
  },
  events: {},
})
