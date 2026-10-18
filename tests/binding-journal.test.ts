import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { bindingJournal, sameMarker, readMarker, type BindingRequest, type JournalHost, type JournalSession, type JournalStore, type Stage } from "./fixtures/phase-zero-plugin/binding-journal.ts"
import { journalStore } from "./fixtures/phase-zero-plugin/journal-store.ts"

async function fixture() {
  const parent = path.join(tmpdir(), "opencode")
  await fs.mkdir(parent, { recursive: true })
  const base = await fs.mkdtemp(path.join(parent, "binding-journal-test-"))
  const file = path.join(base, "journal.sqlite")
  const connections: ReturnType<typeof journalStore>[] = []
  const open = () => { const connection = journalStore(file); connections.push(connection); return connection }
  const store = open()
  const sessions = new Map<string, JournalSession>([
    ["ses_a", { id: "ses_a", marker: undefined }], ["ses_b", { id: "ses_b", marker: undefined }],
  ])
  let publications = 0
  const host: JournalHost = {
    async readSession(id, signal) {
      signal.throwIfAborted()
      const session = sessions.get(id)
      if (!session) throw new Error("Native session not found")
      return structuredClone(session)
    },
    async publish(id, before, after, signal) {
      signal.throwIfAborted()
      const current = sessions.get(id)!
      if (!sameMarker(readMarker(current.marker), before)) return "not-applied"
      publications++
      current.marker = structuredClone(after)
      return "applied"
    },
  }
  const signal = new AbortController().signal
  const service = bindingJournal(store, host)
  const request = (workspaceID: string | null = store.read().workspaces[0]!, sessionID = "ses_a"): BindingRequest => ({ requestID: randomUUID(), sessionID, workspaceID, expectedRevision: store.read().revision })
  const crash = (stage: Stage) => bindingJournal(store, host, async (actual) => { if (actual === stage) throw new Error(`Crash at ${stage}`) })
  const child = (id: string, parentID = "ses_a", fork = false) => {
    sessions.set(id, { id, marker: structuredClone(sessions.get(parentID)!.marker), ...(fork ? { forkSessionID: parentID } : { parentID }) })
  }
  return { base, file, store, open, host, service, signal, request, crash, sessions, child,
    get publications() { return publications },
    async dispose() { for (const connection of connections) connection.close(); await fs.rm(base, { recursive: true, force: true }) },
  }
}
let h: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => { h = await fixture() })
afterEach(async () => { await h.dispose() })

test("a committed binding is authoritative, session-local and idempotent on retry", async () => {
  const request = h.request()
  const result = await h.service.change(request, h.signal)
  expect(result.phase).toBe("committed")
  expect(await h.service.resolve("ses_a", h.signal)).toEqual({ workspaceID: request.workspaceID })
  expect(await h.service.resolve("ses_b", h.signal)).toEqual({ workspaceID: null })
  expect(await h.service.change(request, h.signal)).toEqual(result)
  expect(h.publications).toBe(1)
  expect(Object.keys(h.store.read().tokens)).toHaveLength(1)
})

test("request ID reuse and stale revisions cannot create another publication", async () => {
  const request = h.request()
  await h.service.change(request, h.signal)
  const before = h.store.read()
  await expect(h.service.change({ ...request, workspaceID: null }, h.signal)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" })
  await expect(h.service.change({ ...h.request(), expectedRevision: 0 }, h.signal)).rejects.toMatchObject({ code: "REVISION_CONFLICT" })
  await expect(h.service.change(h.request(randomUUID()), h.signal)).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" })
  expect(h.store.read()).toEqual(before)
  expect(h.publications).toBe(1)
})

test("a prepared-only interruption is safely aborted after reopening storage", async () => {
  const request = h.request()
  await expect(h.crash("prepared").change(request, h.signal)).rejects.toThrow("Crash")
  const recovered = bindingJournal(h.open(), h.host)
  expect((await recovered.recover(request.requestID, h.signal)).phase).toBe("aborted")
  expect((await recovered.change(request, h.signal)).phase).toBe("aborted")
  expect(h.publications).toBe(0)
  expect(h.store.read().bindings).toEqual({})
})

test("recovery fences a live prepared publisher before its native side effect", async () => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const writer = bindingJournal(h.store, h.host, async (stage) => {
    if (stage === "prepared") { entered.resolve(); await resume.promise }
  })
  const request = h.request()
  const publishing = writer.change(request, h.signal)
  await entered.promise
  try {
    const second = bindingJournal(h.open(), h.host)
    expect((await second.recover(request.requestID, h.signal)).phase).toBe("aborted")
  } finally { resume.resolve() }
  expect((await publishing).phase).toBe("aborted")
  expect(h.publications).toBe(0)
})

test("publishing plus an old native marker stays pending, even after restart", async () => {
  const request = h.request()
  await expect(h.crash("publishing").change(request, h.signal)).rejects.toThrow("Crash")
  const recovery = bindingJournal(h.open(), h.host)
  const before = h.store.read()
  await expect(recovery.recover(request.requestID, h.signal)).rejects.toMatchObject({ code: "PUBLICATION_PENDING" })
  await expect(recovery.resolve("ses_a", h.signal)).rejects.toMatchObject({ code: "PUBLICATION_PENDING" })
  await expect(recovery.change(request, h.signal)).rejects.toMatchObject({ code: "PUBLICATION_PENDING" })
  expect(h.store.read()).toEqual(before)
  expect(h.publications).toBe(0)
  // A late host write is still legal: recovery must not have rolled it back.
  h.sessions.get("ses_a")!.marker = { catalogID: before.catalogID, token: before.operations[request.requestID]!.token }
  expect((await recovery.recover(request.requestID, h.signal)).phase).toBe("committed")
})

test("publication committed in the host is finalized without publishing twice", async () => {
  const request = h.request()
  await expect(h.crash("mirror").change(request, h.signal)).rejects.toThrow("Crash")
  expect(h.store.read().bindings).toEqual({})
  const recovery = bindingJournal(h.open(), h.host)
  expect((await recovery.recover(request.requestID, h.signal)).phase).toBe("committed")
  expect((await recovery.change(request, h.signal)).phase).toBe("committed")
  expect(h.publications).toBe(1)
})

test("a child or fork can recover its issuer and keep its older selection", async () => {
  const request = h.request()
  await expect(h.crash("mirror").change(request, h.signal)).rejects.toThrow("Crash")
  h.child("ses_child")
  h.child("ses_fork", "ses_a", true)
  const recovery = bindingJournal(h.open(), h.host)
  expect(await recovery.resolve("ses_child", h.signal)).toEqual({ workspaceID: request.workspaceID })
  const other = h.store.read().workspaces[1]!
  await recovery.change(h.request(other), h.signal)
  expect(await recovery.resolve("ses_fork", h.signal)).toEqual({ workspaceID: request.workspaceID })
  expect(await recovery.resolve("ses_a", h.signal)).toEqual({ workspaceID: other })
})

test("detachment has a real immutable null-selection token for descendants", async () => {
  const first = h.request()
  await h.service.change(first, h.signal)
  await h.service.change(h.request(null), h.signal)
  h.child("ses_detached")
  await h.service.change(h.request(first.workspaceID), h.signal)
  expect(await h.service.resolve("ses_detached", h.signal)).toEqual({ workspaceID: null })
  expect(await h.service.resolve("ses_a", h.signal)).toEqual({ workspaceID: first.workspaceID })
})

test("a failed catalog commit rolls back while preserving the published native token", async () => {
  const failingStore: JournalStore = { read: h.store.read, transact: (update) => h.store.transact((state) => {
    const result = update(state)
    if (Object.values(state.operations).some((item) => item.phase === "committed")) throw new Error("Commit unavailable")
    return result
  }) }
  const request = h.request()
  await expect(bindingJournal(failingStore, h.host).change(request, h.signal)).rejects.toThrow("Commit unavailable")
  expect(h.store.read().operations[request.requestID]!.phase).toBe("publishing")
  expect((await h.service.recover(request.requestID, h.signal)).phase).toBe("committed")
  expect(h.publications).toBe(1)
})

test("a lost success reply is reconciled instead of blindly retried", async () => {
  const request = h.request()
  const host: JournalHost = { ...h.host, publish: async (...args) => { await h.host.publish(...args); throw new Error("Lost reply") } }
  await expect(bindingJournal(h.store, host).change(request, h.signal)).rejects.toThrow("Lost reply")
  expect((await h.service.change(request, h.signal)).phase).toBe("committed")
  expect(h.publications).toBe(1)
})

test("an unknown failure before publication is not guessed to mean rollback", async () => {
  const request = h.request()
  const host: JournalHost = { ...h.host, publish: async () => { throw new Error("Transport unavailable") } }
  await expect(bindingJournal(h.store, host).change(request, h.signal)).rejects.toThrow("Transport unavailable")
  await expect(h.service.recover(request.requestID, h.signal)).rejects.toMatchObject({ code: "PUBLICATION_PENDING" })
  expect(h.store.read().bindings).toEqual({})
})

test("unexpected metadata during recovery is reported, never overwritten", async () => {
  const request = h.request()
  await expect(h.crash("mirror").change(request, h.signal)).rejects.toThrow("Crash")
  const foreign = { catalogID: randomUUID(), token: randomUUID() }
  h.sessions.get("ses_a")!.marker = foreign
  const before = h.store.read()
  await expect(h.service.recover(request.requestID, h.signal)).rejects.toMatchObject({ code: "MIRROR_CONFLICT" })
  expect(h.sessions.get("ses_a")!.marker).toEqual(foreign)
  expect(h.store.read()).toEqual(before)
  expect(h.publications).toBe(1)
})

test("native publish refusal records an abort, not a committed binding", async () => {
  const request = h.request()
  const service = bindingJournal(h.store, { ...h.host, publish: async () => "not-applied" })
  await expect(service.change(request, h.signal)).rejects.toMatchObject({ code: "MIRROR_CONFLICT" })
  expect(h.store.read().operations[request.requestID]!.phase).toBe("aborted")
  expect(h.store.read().bindings).toEqual({})
})

test("valid-looking markers from an unrelated session are not trusted", async () => {
  await h.service.change(h.request(), h.signal)
  h.sessions.get("ses_b")!.marker = structuredClone(h.sessions.get("ses_a")!.marker)
  await expect(h.service.resolve("ses_b", h.signal)).rejects.toMatchObject({ code: "INVALID_ANCESTRY" })
  expect(h.store.read().bindings["ses_b"]).toBeUndefined()
})

test("negative control: ancestry alone cannot authenticate an older-token child override", async () => {
  const original = h.request()
  await h.service.change(original, h.signal)
  const oldMarker = structuredClone(h.sessions.get("ses_a")!.marker)
  const current = h.request(h.store.read().workspaces[1]!)
  await h.service.change(current, h.signal)
  h.child("ses_forged")
  h.sessions.get("ses_forged")!.marker = oldMarker
  expect(await h.service.resolve("ses_a", h.signal)).toEqual({ workspaceID: current.workspaceID })
  // This exposes a host/protocol limitation; it is NOT correct creation-time
  // inheritance and must not be promoted to a production acceptance test.
  expect(await h.service.resolve("ses_forged", h.signal)).toEqual({ workspaceID: original.workspaceID })
})

test("missing, foreign, unknown and malformed inheritance markers fail closed", async () => {
  await h.service.change(h.request(), h.signal)
  h.child("ses_child")
  const session = h.sessions.get("ses_child")!
  session.marker = undefined
  await expect(h.service.resolve(session.id, h.signal)).rejects.toMatchObject({ code: "INHERITANCE_UNAVAILABLE" })
  session.marker = { token: "invalid" }
  await expect(h.service.resolve(session.id, h.signal)).rejects.toMatchObject({ code: "INVALID_MARKER" })
  session.marker = { catalogID: randomUUID(), token: randomUUID() }
  await expect(h.service.resolve(session.id, h.signal)).rejects.toMatchObject({ code: "CATALOG_MISMATCH" })
  session.marker = { catalogID: h.store.read().catalogID, token: randomUUID() }
  await expect(h.service.resolve(session.id, h.signal)).rejects.toMatchObject({ code: "UNKNOWN_TOKEN" })
  expect(h.store.read().bindings[session.id]).toBeUndefined()
})

test("separate store connections cannot both admit the same stale catalog revision", async () => {
  const second = bindingJournal(h.open(), h.host)
  const firstRequest = h.request()
  const secondRequest = h.request(undefined, "ses_b")
  const results = await Promise.allSettled([h.service.change(firstRequest, h.signal), second.change(secondRequest, h.signal)])
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1)
  expect(results.find((item) => item.status === "rejected")).toMatchObject({ reason: { code: "REVISION_CONFLICT" } })
  expect(h.publications).toBe(1)
})

test("issued tokens and terminal operation intents cannot be changed or pruned", async () => {
  const request = h.request()
  await h.service.change(request, h.signal)
  const before = h.store.read()
  expect(() => h.store.transact((state) => {
    const token = state.operations[request.requestID]!.token
    state.tokens[token]!.workspaceID = null
    state.operations[request.requestID]!.workspaceID = null
    state.revision++
  })).toThrow("immutable")
  expect(h.store.read()).toEqual(before)
})

test("future or malformed journals are rejected without replacing stored data", async () => {
  const database = new Database(h.file)
  const original = { ...h.store.read(), version: 99 }
  const text = JSON.stringify(original)
  try {
    database.query("UPDATE probe_catalog SET body = ? WHERE id = 1").run(text)
    expect(() => h.store.read()).toThrow("unsupported")
    await expect(h.service.resolve("ses_a", h.signal)).rejects.toMatchObject({ code: "INVALID_JOURNAL" })
    expect(database.query<{ body: string }, []>("SELECT body FROM probe_catalog WHERE id = 1").get()?.body).toBe(text)
  } finally { database.close() }
})
