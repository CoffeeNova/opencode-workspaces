import { randomUUID } from "node:crypto"
import { z } from "zod"
import { JournalMarker, JournalRequest, JournalRevision as Revision, JournalSessionID as SessionID, JournalStage } from "./journal-rpc.ts"
export { JournalMarker, JournalRequest, JournalStage } from "./journal-rpc.ts"

// Capability experiment only. Neither this schema nor its storage adapter is
// the production v2 registry. No path, tool approval, or instruction is stored.
export const JOURNAL_METADATA_KEY = "workspace-manager.capability-probe.journal"
const Operation = JournalRequest.extend({
  token: z.uuid(), beforeToken: z.uuid().nullable(), phase: z.enum(["prepared", "publishing", "committed", "aborted"]),
}).strict()
const Token = z.object({ ownerSessionID: SessionID, workspaceID: z.uuid().nullable(), requestID: z.uuid() }).strict()
export const JournalSchema = z.object({
  version: z.literal(1), catalogID: z.uuid(), revision: Revision,
  workspaces: z.array(z.uuid()).min(1).max(20),
  bindings: z.record(SessionID, z.uuid()),
  tokens: z.record(z.uuid(), Token),
  operations: z.record(z.uuid(), Operation),
}).strict().superRefine((state, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message })
  if (new Set(state.workspaces).size !== state.workspaces.length) issue("Duplicate workspace IDs")
  const pending = new Set<string>()
  for (const [requestID, operation] of Object.entries(state.operations)) {
    const token = state.tokens[operation.token]
    if (requestID !== operation.requestID || !token || token.requestID !== requestID || token.ownerSessionID !== operation.sessionID || token.workspaceID !== operation.workspaceID) issue("Invalid operation/token relationship")
    if (operation.beforeToken !== null && !state.tokens[operation.beforeToken]) issue("Unknown previous token")
    if (operation.workspaceID !== null && !state.workspaces.includes(operation.workspaceID)) issue("Unknown workspace ID")
    if (operation.phase === "prepared" || operation.phase === "publishing") {
      if (pending.has(operation.sessionID)) issue("Multiple pending operations for one session")
      pending.add(operation.sessionID)
    }
  }
  for (const [id, token] of Object.entries(state.tokens)) {
    if (state.operations[token.requestID]?.token !== id) issue("Orphan token")
  }
  for (const tokenID of Object.values(state.bindings)) {
    const token = state.tokens[tokenID]
    if (!token || state.operations[token.requestID]?.phase !== "committed") issue("Binding does not refer to a committed token")
  }
})

export type Journal = z.infer<typeof JournalSchema>
export type BindingRequest = z.infer<typeof JournalRequest>
export type Marker = z.infer<typeof JournalMarker>
export type Stage = z.infer<typeof JournalStage>
export type BindingOperation = z.infer<typeof Operation>
export type JournalSession = { id: string; parentID?: string; forkSessionID?: string; marker: unknown }
export type JournalStore = {
  read(): Journal
  transact<T>(update: (state: Journal) => T): T
}
export type JournalHost = {
  readSession(sessionID: string, signal: AbortSignal): Promise<JournalSession>
  // Required port semantics, NOT an invented OpenCode API. The real probe
  // adapter is explicitly cooperative-only: the host has no native metadata CAS.
  publish(sessionID: string, before: Marker | null, after: Marker, signal: AbortSignal): Promise<"applied" | "not-applied">
}
export class JournalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "JournalError" }
}
function fail(code: string, message: string): never { throw new JournalError(code, message) }
function bump(state: Journal) {
  if (state.revision === Number.MAX_SAFE_INTEGER) fail("JOURNAL_FULL", "Probe revision is exhausted")
  state.revision++
}
export function emptyJournal(): Journal {
  return { version: 1, catalogID: randomUUID(), revision: 0, workspaces: [randomUUID(), randomUUID()], bindings: {}, tokens: {}, operations: {} }
}
export function sameMarker(left: Marker | null, right: Marker | null) {
  return left === null || right === null ? left === right : left.catalogID === right.catalogID && left.token === right.token
}
export function readMarker(raw: unknown): Marker | null {
  if (raw === undefined) return null
  const marker = JournalMarker.safeParse(raw)
  if (!marker.success) fail("INVALID_MARKER", "The native inheritance marker is malformed")
  return marker.data
}

export function bindingJournal(store: JournalStore, host: JournalHost, fault?: (stage: Stage, operation: BindingOperation) => Promise<void>) {
  const operation = (requestID: string) => store.read().operations[requestID] ?? fail("UNKNOWN_REQUEST", "Unknown probe request ID")
  const result = (value: BindingOperation) => ({ requestID: value.requestID, phase: value.phase, workspaceID: value.workspaceID, revision: store.read().revision })
  const sameIntent = (left: BindingOperation, right: BindingRequest) => left.sessionID === right.sessionID && left.workspaceID === right.workspaceID && left.expectedRevision === right.expectedRevision
  const native = async (sessionID: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const session = await host.readSession(sessionID, signal)
    if (session.id !== sessionID) fail("INVALID_SESSION", "The host returned a different session")
    return session
  }
  async function recover(requestID: string, signal: AbortSignal) {
    const pending = operation(requestID)
    if (pending.phase === "committed" || pending.phase === "aborted") return result(pending)
    if (pending.phase === "prepared") {
      // Publication cannot start until the durable publishing transition wins.
      // This compare-and-transition also fences a still-live prepared publisher.
      store.transact((state) => {
        const current = state.operations[requestID]!
        if (current.phase === "prepared") { current.phase = "aborted"; bump(state) }
      })
      const current = operation(requestID)
      if (current.phase !== "publishing") return result(current)
    }
    const current = operation(requestID)
    const state = store.read()
    const marker = readMarker((await native(current.sessionID, signal)).marker)
    const desired = { catalogID: state.catalogID, token: current.token }
    const before = current.beforeToken === null ? null : { catalogID: state.catalogID, token: current.beforeToken }
    const settled = operation(requestID)
    if (settled.phase === "committed" || settled.phase === "aborted") return result(settled)
    if (!sameMarker(marker, desired)) {
      if (sameMarker(marker, before)) fail("PUBLICATION_PENDING", "The native publication outcome is unknown; do not retry or roll back blindly")
      fail("MIRROR_CONFLICT", "Native metadata disagrees with the pending journal; no metadata was overwritten")
    }
    signal.throwIfAborted()
    store.transact((draft) => {
      const latest = draft.operations[requestID]!
      if (latest.phase === "committed") return
      if (latest.phase !== "publishing" || (draft.bindings[latest.sessionID] ?? null) !== latest.beforeToken) fail("JOURNAL_CONFLICT", "Pending binding ownership changed")
      draft.bindings[latest.sessionID] = latest.token
      latest.phase = "committed"
      bump(draft)
    })
    return result(operation(requestID))
  }
  async function lineage(session: JournalSession, owner: string | undefined, signal: AbortSignal) {
    const seen = new Set<string>()
    let current: JournalSession | undefined = session
    for (let depth = 0; current && depth < 128; depth++) {
      if (seen.has(current.id)) fail("INVALID_ANCESTRY", "Cyclic native session ancestry")
      seen.add(current.id)
      if (owner === current.id) return true
      if (owner === undefined && current.id !== session.id) {
        const state = store.read()
        const candidate = current.id
        if (Object.values(state.tokens).some((token) => token.ownerSessionID === candidate && ["publishing", "committed"].includes(state.operations[token.requestID]!.phase))) return true
      }
      if (current.parentID && current.forkSessionID && current.parentID !== current.forkSessionID) fail("INVALID_ANCESTRY", "Ambiguous native ancestry")
      const parent: string | undefined = current.parentID ?? current.forkSessionID
      current = parent ? await native(parent, signal) : undefined
    }
    if (current) fail("INVALID_ANCESTRY", "Native session ancestry exceeds the probe limit")
    return false
  }
  async function inspect(sessionID: string, signal: AbortSignal) {
    const session = await native(sessionID, signal)
    const marker = readMarker(session.marker)
    const state = store.read()
    if (marker === null) {
      if (state.bindings[sessionID]) fail("MIRROR_CONFLICT", "A registered session lost its native marker")
      if (await lineage(session, undefined, signal)) fail("INHERITANCE_UNAVAILABLE", "A managed ancestor exists but the creation marker is missing")
      return { token: null, workspaceID: null }
    }
    if (marker.catalogID !== state.catalogID) fail("CATALOG_MISMATCH", "The marker belongs to another catalog")
    const token = state.tokens[marker.token] ?? fail("UNKNOWN_TOKEN", "The marker was not issued by this journal")
    if (!(await lineage(session, token.ownerSessionID, signal))) fail("INVALID_ANCESTRY", "The issued token does not belong to this session or its native ancestors")
    const source = await recover(token.requestID, signal)
    if (source.phase !== "committed") fail("UNCOMMITTED_TOKEN", "The marker refers to an aborted or uncommitted operation")
    const bound = store.read().bindings[sessionID]
    if (bound !== undefined && bound !== marker.token) fail("MIRROR_CONFLICT", "The marker cannot replace an authoritative binding")
    return { token: marker.token, workspaceID: token.workspaceID }
  }
  return {
    status: () => {
      const state = store.read()
      return {
        catalogID: state.catalogID, revision: state.revision, workspaceIDs: state.workspaces,
        bindings: Object.entries(state.bindings).map(([sessionID, token]) => ({ sessionID, workspaceID: state.tokens[token]!.workspaceID })),
        operations: Object.values(state.operations).map(({ requestID, sessionID, phase }) => ({ requestID, sessionID, phase })),
      }
    },
    recover,
    async resolve(sessionID: string, signal: AbortSignal) {
      // A local publisher may have committed its native marker but not its journal.
      const local = Object.values(store.read().operations).find((item) => item.sessionID === sessionID && (item.phase === "prepared" || item.phase === "publishing"))
      if (local) await recover(local.requestID, signal)
      const selected = await inspect(sessionID, signal)
      signal.throwIfAborted()
      if (selected.token !== null) store.transact((state) => {
        const existing = state.bindings[sessionID]
        if (existing !== undefined && existing !== selected.token) fail("MIRROR_CONFLICT", "Concurrent binding changed")
        if (existing === undefined) { state.bindings[sessionID] = selected.token!; bump(state) }
      })
      return { workspaceID: selected.workspaceID }
    },
    async change(input: BindingRequest, signal: AbortSignal) {
      const request = JournalRequest.parse(input)
      signal.throwIfAborted()
      const replay = store.read().operations[request.requestID]
      if (replay) {
        if (!sameIntent(replay, request)) fail("REQUEST_CONFLICT", "A request ID cannot be reused for another intent")
        if (replay.phase === "prepared") fail("PUBLICATION_PENDING", "This request is already prepared; retries cannot restart its publisher")
        return recover(request.requestID, signal)
      }
      const selected = await inspect(request.sessionID, signal)
      signal.throwIfAborted()
      const prepared = store.transact((state) => {
        // A second connection can have admitted the exact same request meanwhile.
        const repeated = state.operations[request.requestID]
        if (repeated) return false
        if (state.revision !== request.expectedRevision) fail("REVISION_CONFLICT", "The probe catalog revision changed")
        if (request.workspaceID !== null && !state.workspaces.includes(request.workspaceID)) fail("UNKNOWN_WORKSPACE", "Unknown probe workspace ID")
        if (Object.values(state.operations).some((item) => item.sessionID === request.sessionID && (item.phase === "prepared" || item.phase === "publishing"))) fail("PUBLICATION_PENDING", "This session already has an unfinished publication")
        if ((state.bindings[request.sessionID] ?? selected.token) !== selected.token) fail("MIRROR_CONFLICT", "The authoritative binding changed")
        if (selected.token !== null) state.bindings[request.sessionID] = selected.token
        const token = randomUUID()
        state.tokens[token] = { ownerSessionID: request.sessionID, workspaceID: request.workspaceID, requestID: request.requestID }
        state.operations[request.requestID] = { ...request, token, beforeToken: selected.token, phase: "prepared" }
        bump(state)
        return true
      })
      if (!prepared) {
        const repeated = operation(request.requestID)
        if (!sameIntent(repeated, request)) fail("REQUEST_CONFLICT", "A request ID cannot be reused for another intent")
        if (repeated.phase === "prepared") fail("PUBLICATION_PENDING", "This request is already prepared")
        return recover(request.requestID, signal)
      }
      await fault?.("prepared", structuredClone(operation(request.requestID)))
      signal.throwIfAborted()
      const publish = store.transact((state) => {
        const current = state.operations[request.requestID]!
        if (current.phase !== "prepared") return false
        current.phase = "publishing"
        bump(state)
        return true
      })
      if (!publish) return recover(request.requestID, signal)
      const current = operation(request.requestID)
      await fault?.("publishing", structuredClone(current))
      signal.throwIfAborted()
      const state = store.read()
      const before = current.beforeToken === null ? null : { catalogID: state.catalogID, token: current.beforeToken }
      const outcome = await host.publish(request.sessionID, before, { catalogID: state.catalogID, token: current.token }, signal)
      if (outcome === "not-applied") {
        store.transact((draft) => {
          const pending = draft.operations[request.requestID]!
          if (pending.phase !== "publishing") fail("JOURNAL_CONFLICT", "Publication phase changed")
          pending.phase = "aborted"
          bump(draft)
        })
        fail("MIRROR_CONFLICT", "The publisher refused the expected marker; nothing was overwritten by this operation")
      }
      await fault?.("mirror", structuredClone(current))
      return recover(request.requestID, signal)
    },
  }
}
