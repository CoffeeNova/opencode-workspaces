import type { OpenCode } from "@opencode/client"
import { Database } from "bun:sqlite"
import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { JOURNAL_METADATA_KEY, JournalSchema, type BindingRequest, type Stage } from "../fixtures/phase-zero-plugin/binding-journal.ts"
import { JournalProbe } from "../fixtures/phase-zero-plugin/journal-rpc.ts"
import type { PauseStage } from "../fixtures/phase-zero-plugin/journal-pause.ts"

type Client = ReturnType<typeof OpenCode.make>
const Metadata = z.record(z.string(), z.json())

// All mutations use public APIs against fixture sessions. The only direct DB
// inspection is read-only access to our separate fixture journal, never the
// native OpenCode database. No model/prompt API is used by these checks.
export async function checkJournalCapability(
  initialClient: Client, fixture: { base: string; launch: string; other: string }, forkSourceID: string, restart: () => Promise<Client>,
) {
  let client = initialClient
  let restarts = 0
  const location = { directory: fixture.launch.replaceAll("\\", "/") }
  const options = () => ({ location, signal: AbortSignal.timeout(10_000) })
  const rpc = () => client.rpc(JournalProbe)
  const evidence: Record<string, unknown>[] = []
  const sessions = new Map<string, string>()
  const checks: { sessionID: string; workspaceID: string | null }[] = []
  const file = path.join(fixture.base, "binding-journal.sqlite")
  function stored() {
    const database = new Database(file, { readonly: true, strict: true })
    try {
      assert.equal(database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check, "ok")
      const row = database.query<{ body: string }, []>("SELECT body FROM probe_catalog WHERE id = 1").get()
      assert.ok(row)
      return JournalSchema.parse(JSON.parse(row.body))
    } finally { database.close() }
  }
  async function remember(sessionID: string) {
    sessions.set(sessionID, JSON.stringify(await client.session.context({ sessionID })))
    return sessionID
  }
  async function create(title: string, parentID?: string) {
    const session = await client.session.create(parentID ? { parentID, title } : { location, title })
    return remember(session.id)
  }
  async function fork(parentID: string) {
    const session = await client.session.fork({ sessionID: parentID })
    assert.equal(session.fork?.sessionID, parentID)
    return remember(session.id)
  }
  async function forkable(title: string) {
    // OpenCode 2.0.32 rejects forks of empty sessions. Reuse an already scripted
    // fixture transcript, rather than generating or synthesizing admin messages.
    const sessionID = await fork(forkSourceID)
    await client.session.update({ sessionID, title })
    return sessionID
  }
  const metadata = async (sessionID: string) => (await client.session.get({ sessionID })).metadata
  const marker = async (sessionID: string) => (await metadata(sessionID))?.[JOURNAL_METADATA_KEY]
  async function setMarker(sessionID: string, value: unknown) {
    // JSON fixture data only; the public client enforces the native metadata shape.
    const values = { ...await metadata(sessionID), [JOURNAL_METADATA_KEY]: value }
    if (value === undefined) delete values[JOURNAL_METADATA_KEY]
    await client.session.update({ sessionID, metadata: Metadata.parse(values) })
  }
  async function request(sessionID: string, workspaceID: string | null): Promise<BindingRequest> {
    return { sessionID, workspaceID, requestID: randomUUID(), expectedRevision: (await rpc().status({}, options())).revision }
  }
  async function change(sessionID: string, workspaceID: string | null) {
    const input = await request(sessionID, workspaceID)
    assert.equal((await rpc().change(input, options())).phase, "committed")
    return input
  }
  async function selected(sessionID: string, workspaceID: string | null) {
    assert.deepEqual(await rpc().resolve({ sessionID }, options()), { workspaceID })
  }
  async function rejected(action: Promise<unknown>, code: string) {
    await assert.rejects(action, (error: unknown) => {
      assert.ok(error && typeof error === "object" && "type" in error && "data" in error, JSON.stringify(error))
      assert.equal(error.type, "journal_error")
      assert.ok(error.data && typeof error.data === "object" && "code" in error.data)
      assert.equal(error.data.code, code)
      return true
    })
  }
  async function unchanged(sessionID: string, action: () => Promise<unknown>, code: string) {
    const state = stored()
    const native = await metadata(sessionID)
    await rejected(action(), code)
    assert.deepEqual(stored(), state, `${code} must not mutate the journal`)
    assert.deepEqual(await metadata(sessionID), native, `${code} must not overwrite native metadata`)
    evidence.push({ check: "fail-closed", sessionID, code })
  }
  async function reboot() {
    const before = stored()
    client = await restart()
    restarts++
    await client.model.list({ location })
    assert.deepEqual(stored(), before, "Starting a new plugin instance must not guess journal recovery")
    assert.deepEqual(await rpc().paused({}, options()), { pause: null }, "Test scheduling state must not survive restart")
  }
  async function paused(requestID: string, stage: PauseStage) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const status = await rpc().paused({}, options())
      if (status.pause?.requestID === requestID) {
        assert.equal(status.pause.stage, stage)
        return
      }
      await Bun.sleep(10)
    }
    assert.fail(`Publication ${requestID} did not pause at ${stage}`)
  }

  try {
    const initial = await rpc().status({}, options())
    assert.equal(initial.revision, 0)
    assert.deepEqual(initial.bindings, [])
    const [one, two] = initial.workspaceIDs
    assert.ok(one && two)
    const ordinary = await create("Journal ordinary unbound session")
    const empty = stored()
    await selected(ordinary, null)
    assert.deepEqual(stored(), empty, "Ordinary unbound sessions do not acquire a guessed binding")

    const parentID = await create("Journal idempotency parent")
    await client.session.update({ sessionID: parentID, metadata: { unrelated: { retained: true } } })
    const committed = await change(parentID, one)
    const firstMarker = await marker(parentID)
    const committedState = stored()
    const committedNative = await metadata(parentID)
    assert.equal((await rpc().change(committed, options())).phase, "committed")
    assert.deepEqual(stored(), committedState, "An idempotent retry must not issue another token")
    assert.deepEqual(await metadata(parentID), committedNative)
    await selected(parentID, one)
    await selected(ordinary, null)
    evidence.push({ check: "commit-and-idempotent-retry", requestID: committed.requestID, sessionID: parentID })

    const faults: { stage: Stage; request: BindingRequest; childID: string; forkID: string; before: unknown }[] = []
    for (const stage of ["prepared", "publishing", "mirror"] as const) {
      const sessionID = await forkable(`Journal crash at ${stage}`)
      await change(sessionID, one)
      const before = await metadata(sessionID)
      const input = await request(sessionID, two)
      await rejected(rpc().change({ ...input, interruptAfter: stage }, options()), "PROBE_INTERRUPTED")
      const state = stored()
      assert.equal(state.operations[input.requestID]?.phase, stage === "prepared" ? "prepared" : "publishing")
      assert.equal(state.tokens[state.bindings[sessionID]!]!.workspaceID, one)
      if (stage !== "mirror") assert.deepEqual(await metadata(sessionID), before)
      else assert.deepEqual(await marker(sessionID), { catalogID: initial.catalogID, token: state.operations[input.requestID]!.token })
      // Neither descendant is resolved until after the private server is killed.
      faults.push({ stage, request: input, childID: await create(`Unobserved ${stage} child`, sessionID), forkID: await fork(sessionID), before })
      evidence.push({ check: "injected-fault-before-restart", stage, requestID: input.requestID, phase: state.operations[input.requestID]!.phase })
    }
    const detached = await forkable("Journal detach interrupted after mirror")
    await change(detached, one)
    const detach = await request(detached, null)
    await rejected(rpc().change({ ...detach, interruptAfter: "mirror" }, options()), "PROBE_INTERRUPTED")
    const detachedChild = await create("Unobserved detached child", detached)
    const detachedFork = await fork(detached)

    const conflict = await create("Journal published marker replaced before recovery")
    const conflictRequest = await request(conflict, one)
    await rejected(rpc().change({ ...conflictRequest, interruptAfter: "mirror" }, options()), "PROBE_INTERRUPTED")
    await setMarker(conflict, { catalogID: randomUUID(), token: randomUUID() })
    const unknownPublication = faults.find((item) => item.stage === "publishing")!
    await reboot()

    for (const item of faults) {
      const { sessionID, requestID } = item.request
      if (item.stage === "prepared") {
        assert.equal((await rpc().recover({ requestID }, options())).phase, "aborted")
        const state = stored()
        assert.equal((await rpc().change(item.request, options())).phase, "aborted")
        assert.deepEqual(stored(), state)
        assert.deepEqual(await metadata(sessionID), item.before)
        await change(sessionID, two)
        await selected(item.childID, one)
        await selected(item.forkID, one)
        checks.push({ sessionID, workspaceID: two }, { sessionID: item.childID, workspaceID: one }, { sessionID: item.forkID, workspaceID: one })
      } else if (item.stage === "publishing") {
        await unchanged(sessionID, () => rpc().recover({ requestID }, options()), "PUBLICATION_PENDING")
        await unchanged(sessionID, () => rpc().change(item.request, options()), "PUBLICATION_PENDING")
        await unchanged(sessionID, () => rpc().resolve({ sessionID }, options()), "PUBLICATION_PENDING")
        await unchanged(sessionID, async () => rpc().change(await request(sessionID, null), options()), "PUBLICATION_PENDING")
        await selected(item.childID, one)
        await selected(item.forkID, one)
        checks.push({ sessionID: item.childID, workspaceID: one }, { sessionID: item.forkID, workspaceID: one })
      } else {
        // Child resolution first reconciles its issuer's exact native marker.
        await selected(item.childID, two)
        assert.equal(stored().operations[requestID]?.phase, "committed")
        await change(sessionID, one)
        // Fork's first inspection is deliberately after another parent switch.
        await selected(item.forkID, two)
        const grandchild = await create("Journal inheritance grandchild", item.childID)
        await selected(grandchild, two)
        checks.push({ sessionID, workspaceID: one }, { sessionID: item.childID, workspaceID: two }, { sessionID: item.forkID, workspaceID: two }, { sessionID: grandchild, workspaceID: two })
      }
      evidence.push({ check: "fault-recovery-after-restart", stage: item.stage, requestID, phase: stored().operations[requestID]!.phase })
    }
    await selected(detachedChild, null)
    assert.equal(stored().operations[detach.requestID]?.phase, "committed")
    await change(detached, two)
    await selected(detachedFork, null)
    checks.push({ sessionID: detached, workspaceID: two }, { sessionID: detachedChild, workspaceID: null }, { sessionID: detachedFork, workspaceID: null })
    evidence.push({ check: "null-token-detachment-and-inheritance", requestID: detach.requestID, detachedChild, detachedFork })
    await unchanged(conflict, () => rpc().recover({ requestID: conflictRequest.requestID }, options()), "MIRROR_CONFLICT")

    await unchanged(parentID, () => rpc().change({ ...committed, workspaceID: null }, options()), "REQUEST_CONFLICT")
    await unchanged(parentID, () => rpc().change({ ...committed, requestID: randomUUID(), expectedRevision: 0 }, options()), "REVISION_CONFLICT")
    await unchanged(parentID, async () => rpc().change(await request(parentID, randomUUID()), options()), "UNKNOWN_WORKSPACE")
    await unchanged(parentID, () => rpc().recover({ requestID: randomUUID() }, options()), "UNKNOWN_REQUEST")
    const invalid = await create("Journal invalid marker")
    for (const [value, code] of [
      [{ token: "malformed" }, "INVALID_MARKER"],
      [{ catalogID: randomUUID(), token: randomUUID() }, "CATALOG_MISMATCH"],
      [{ catalogID: initial.catalogID, token: randomUUID() }, "UNKNOWN_TOKEN"],
      [firstMarker, "INVALID_ANCESTRY"],
    ] as const) {
      await setMarker(invalid, value)
      await unchanged(invalid, () => rpc().resolve({ sessionID: invalid }, options()), code)
      await unchanged(invalid, async () => rpc().change(await request(invalid, one), options()), code)
    }
    const overridden = await client.session.create({ parentID, title: "Journal explicit child metadata override", metadata: { unrelated: "override" } })
    await remember(overridden.id)
    await unchanged(overridden.id, () => rpc().resolve({ sessionID: overridden.id }, options()), "INHERITANCE_UNAVAILABLE")
    const aborted = faults.find((item) => item.stage === "prepared")!
    await setMarker(aborted.childID, { catalogID: initial.catalogID, token: stored().operations[aborted.request.requestID]!.token })
    await unchanged(aborted.childID, () => rpc().resolve({ sessionID: aborted.childID }, options()), "UNCOMMITTED_TOKEN")
    // Restore only this probe's deliberately overwritten synthetic marker.
    await setMarker(aborted.childID, await marker(aborted.forkID))
    await change(parentID, two)
    const currentMarker = await marker(parentID)
    await setMarker(parentID, firstMarker)
    await unchanged(parentID, () => rpc().resolve({ sessionID: parentID }, options()), "MIRROR_CONFLICT")
    await setMarker(parentID, undefined)
    await unchanged(parentID, () => rpc().resolve({ sessionID: parentID }, options()), "MIRROR_CONFLICT")
    await setMarker(parentID, currentMarker)
    const other = await client.session.create({ location: { directory: fixture.other.replaceAll("\\", "/") }, title: "Journal foreign Location" })
    await remember(other.id)
    await unchanged(other.id, () => rpc().resolve({ sessionID: other.id }, options()), "LOCATION_MISMATCH")
    await unchanged(other.id, async () => rpc().change(await request(other.id, one), options()), "LOCATION_MISMATCH")

    const fenced = await create("Journal live prepared publisher fencing")
    await change(fenced, one)
    const fenceRequest = await request(fenced, two)
    const fenceNative = await metadata(fenced)
    const publishing = rpc().change({ ...fenceRequest, pauseAfter: "prepared" }, options())
    void publishing.catch(() => {})
    await paused(fenceRequest.requestID, "prepared")
    try {
      assert.equal((await rpc().recover({ requestID: fenceRequest.requestID }, options())).phase, "aborted")
    } finally { await rpc().release({ requestID: fenceRequest.requestID }, options()) }
    assert.equal((await publishing).phase, "aborted")
    assert.deepEqual(await metadata(fenced), fenceNative, "The resumed publisher must observe the durable abort before writing")
    await selected(fenced, one)
    checks.push({ sessionID: fenced, workspaceID: one })
    evidence.push({ check: "live-prepared-publisher-fenced", requestID: fenceRequest.requestID })

    // Negative control on the ACTUAL read/merge/write adapter, not the atomic
    // fake host. A different public client update lands between get and update.
    const raced = await create("Journal non-atomic metadata negative control")
    await client.session.update({ sessionID: raced, metadata: { baseline: "retained" } })
    const raceRequest = await request(raced, one)
    const racing = rpc().change({ ...raceRequest, pauseAfter: "metadata-read" }, options())
    void racing.catch(() => {})
    await paused(raceRequest.requestID, "metadata-read")
    const interveningMarker = { catalogID: randomUUID(), token: randomUUID() }
    try {
      await client.session.update({ sessionID: raced, metadata: { ...await metadata(raced), otherWriter: "must-not-be-lost", [JOURNAL_METADATA_KEY]: interveningMarker } })
      assert.equal((await metadata(raced))?.otherWriter, "must-not-be-lost")
      assert.deepEqual(await marker(raced), interveningMarker)
    } finally { await rpc().release({ requestID: raceRequest.requestID }, options()) }
    assert.equal((await racing).phase, "committed")
    assert.equal((await metadata(raced))?.baseline, "retained")
    assert.equal((await metadata(raced))?.otherWriter, undefined, "Negative control must expose the adapter's lost metadata update")
    assert.notDeepEqual(await marker(raced), interveningMarker, "The non-CAS adapter also overwrites an intervening marker conflict")
    checks.push({ sessionID: raced, workspaceID: one })
    evidence.push({ check: "negative-control", limitation: "real-journal-adapter-loses-concurrent-metadata-field-and-marker-conflict", requestID: raceRequest.requestID })

    // Native ancestry authenticates the issuer, NOT which of that issuer's old
    // tokens was really inherited at creation. This explicitly forged override
    // is indistinguishable through the current public adapter and is NOT a pass
    // for the production creation-time binding contract.
    const forged = await client.session.create({ parentID, title: "Journal same-ancestry old-token negative control", metadata: { [JOURNAL_METADATA_KEY]: firstMarker! } })
    await remember(forged.id)
    await selected(parentID, two)
    await selected(forged.id, one)
    evidence.push({ check: "negative-control", limitation: "same-ancestry-metadata-override-can-forge-older-selection", sessionID: forged.id, actualParentWorkspaceID: two, acceptedWorkspaceID: one })
    checks.push({ sessionID: parentID, workspaceID: two }, { sessionID: forged.id, workspaceID: one }, { sessionID: ordinary, workspaceID: null })

    await reboot()
    const restored = stored()
    for (const check of checks) await selected(check.sessionID, check.workspaceID)
    assert.deepEqual(stored(), restored, "Already resolved bindings must remain unchanged on restart/retry")
    await unchanged(unknownPublication.request.sessionID, () => rpc().recover({ requestID: unknownPublication.request.requestID }, options()), "PUBLICATION_PENDING")
    await unchanged(conflict, () => rpc().recover({ requestID: conflictRequest.requestID }, options()), "MIRROR_CONFLICT")
    assert.equal((await metadata(raced))?.otherWriter, undefined)
    for (const [sessionID, context] of sessions) assert.equal(JSON.stringify(await client.session.context({ sessionID })), context, "Journal administration must not alter conversation history")
    evidence.push({ check: "second-restart", restarts, persistedSelections: checks.length, journalIntegrity: "ok" })
    console.log("PASS journal commit/retry + prepared/publishing/mirror faults across private-server restarts")
    console.log("PASS journal child/fork/grandchild/null-token inheritance + prepared publisher fencing")
    console.log("PASS pre-existing journal marker/revision/Location/recovery conflicts reject without metadata overwrite")
    console.log("CONFIRMED LIMIT: real journal read/merge/write loses a concurrent metadata field")
    console.log("CONFIRMED LIMIT: same-ancestry metadata override can forge an older selection")
    return { restarts, checks: evidence.length, limitations: ["journal-native-metadata-publisher-is-not-cas", "same-ancestry-token-override-is-not-authenticated", "publishing-with-old-marker-remains-indeterminate"] }
  } finally {
    await fs.writeFile(path.join(fixture.base, "journal-results.json"), JSON.stringify({ restarts, evidence }, null, 2))
  }
}
