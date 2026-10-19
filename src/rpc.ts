import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { Change, LegacyImportResult, LegacyPreview, Selection, SessionID, State } from "./domain.ts"

const errors = { workspace: z.object({ code: z.string() }).strict() }
export const WorkspaceRPC = Rpc.define({
  id: "workspace-manager.v2",
  methods: {
    state: { input: z.object({ sessionID: SessionID.optional() }).strict(), output: State, errors },
    selection: { input: z.object({ sessionID: SessionID }).strict(), output: Selection, errors },
    change: { input: Change, output: State, errors },
    legacyPreview: { input: z.object({ path: z.string().min(1).max(32768) }).strict(), output: LegacyPreview, errors },
    importLegacy: { input: z.object({ path: z.string().min(1).max(32768), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().nonnegative() }).strict(), output: LegacyImportResult, errors },
    browse: { input: z.object({ path: z.string().optional() }).strict(), output: z.object({ current: z.string(), parent: z.string().nullable(), suggestedAlias: z.string(), directories: z.array(z.object({ name: z.string(), path: z.string() })), truncated: z.boolean() }).strict(), errors },
  },
  events: { changed: { schema: z.object({ catalogID: z.uuid(), revision: z.number().int().nonnegative(), sessionID: SessionID.optional() }).strict() } },
})
