import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { BoundaryProbe, CapabilityProbe, INHERITANCE_METADATA_KEY } from "../fixtures/phase-zero-plugin/rpc.ts"
import type { OpenCode } from "@opencode/client"

type Client = ReturnType<typeof OpenCode.make>
type Marker = { catalogID: string; token: string }

export type ScriptedCall = { name: string; input: Record<string, unknown> }
export function heldReply() {
  return { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<ScriptedCall[]>() }
}
export type ScriptedReply = ScriptedCall[] | ReturnType<typeof heldReply>

export async function checkIdleWaitCapability(client: Client, directory: string, sessionID: string, idleSessionID: string, enqueue: (reply: ScriptedReply) => void) {
  const location = { directory }
  const probe = client.rpc(CapabilityProbe)
  const boundary = client.rpc(BoundaryProbe)
  const initial = await boundary.status({}, { location })
  const reply = heldReply()
  enqueue(reply)
  const deadline = setTimeout(() => reply.entered.reject(new Error("Held provider request did not start")), 15_000)
  let negative: Promise<{ idle: boolean }> | undefined
  let negativeSettled = false
  try {
    await client.session.prompt({ sessionID, text: "Hold this disposable model request until the idle-boundary checks finish." })
    await reply.entered.promise
    assert.ok(Object.hasOwn(await client.session.active(), sessionID))
    negative = probe.waitIdle({ sessionID, timeoutMs: 10 }, { location, signal: AbortSignal.timeout(15_000) })
    void negative.finally(() => { negativeSettled = true }).catch(() => {})
    assert.deepEqual(await boundary.waitIdle({ sessionID, timeoutMs: 150 }, { location, signal: AbortSignal.timeout(10_000) }), { idle: false })
    assert.equal(negativeSettled, false, "The Promise adapter still ignores its native-wait AbortSignal")
    await assert.rejects(boundary.advanceEpoch({ sessionIDs: [idleSessionID, sessionID], expectedEpoch: initial.epoch }, { location }), { type: "session_busy" })
    assert.equal((await boundary.status({}, { location })).epoch, initial.epoch)
    assert.ok(Object.hasOwn(await client.session.active(), sessionID), "Cancelling the idle waiter must not interrupt the agent")
    assert.deepEqual(await boundary.waitIdle({ sessionID: idleSessionID, timeoutMs: 500 }, { location }), { idle: true })
    const cancellation = new AbortController()
    const waiting = boundary.waitIdle({ sessionID, timeoutMs: 5000 }, { location, signal: cancellation.signal })
    cancellation.abort()
    await assert.rejects(waiting)
    assert.ok(Object.hasOwn(await client.session.active(), sessionID))
  } finally {
    clearTimeout(deadline)
    reply.release.resolve([])
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) })
    if (negative) assert.deepEqual(await negative, { idle: true }, "Negative control only settles after the session becomes idle")
  }
  assert.deepEqual(await boundary.waitIdle({ sessionID, timeoutMs: 500 }, { location }), { idle: true })
  assert.deepEqual(await boundary.advanceEpoch({ sessionIDs: [sessionID, idleSessionID], expectedEpoch: initial.epoch }, { location }), { epoch: initial.epoch + 1 })
  await assert.rejects(boundary.advanceEpoch({ sessionIDs: [sessionID], expectedEpoch: initial.epoch }, { location }), { type: "revision_conflict" })
  console.log("PASS Effect idle wait is cancellable; Promise adapter negative control is not")
  console.log("PASS conservative epoch mutation rejects busy/shared sessions and stale revisions")
}

export async function checkToolBoundaryCapability(
  client: Client, directory: string, sessionID: string, workdir: string, providerOrigin: string,
  enqueue: (reply: ScriptedReply) => void, hold: ReturnType<typeof heldReply>,
) {
  const location = { directory }
  const boundary = client.rpc(BoundaryProbe)
  const initial = await boundary.status({}, { location })
  const file = path.join(workdir, "boundary-hold.cjs")
  await fs.writeFile(file, `fetch(${JSON.stringify(`${providerOrigin}/native-hold`)}).then(async r => { if (!r.ok) throw new Error('Fixture hold failed'); process.stdout.write(await r.text()) }).catch(e => { console.error(String(e)); process.exitCode = 1 })\n`)
  enqueue([{ name: "shell", input: { command: "node boundary-hold.cjs", workdir, timeout: 30_000 } }])
  const deadline = setTimeout(() => hold.entered.reject(new Error("Native shell did not enter the hold fixture")), 15_000)
  try {
    await client.session.prompt({ sessionID, text: "Run the disposable held native shell." })
    await hold.entered.promise
    await assert.rejects(boundary.advanceEpoch({ sessionIDs: [sessionID], expectedEpoch: initial.epoch }, { location }), { type: "session_busy" })
    assert.equal((await boundary.status({}, { location })).epoch, initial.epoch)
    await client.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(15_000) })
    // Prove interruption releases the executor before releasing its HTTP hold;
    // otherwise normal command completion could hide a leaked cancellation path.
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(5000) })
    assert.equal(Object.hasOwn(await client.session.active(), sessionID), false)
    assert.deepEqual(await boundary.advanceEpoch({ sessionIDs: [sessionID], expectedEpoch: initial.epoch }, { location }), { epoch: initial.epoch + 1 })
  } finally {
    clearTimeout(deadline)
    hold.release.resolve([])
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) })
  }
  assert.equal((await boundary.status({}, { location })).epoch, initial.epoch + 1)
  console.log("PASS native executor gate survives shell interruption with no leaked permit")
}

// Only native metadata in the disposable database is modified. These markers
// are not a workspace binding store and do not authorize filesystem access.
export async function checkInheritanceCapability(client: Client, directory: string, parentID: string) {
  const location = { directory }
  const probe = client.rpc(CapabilityProbe)
  const catalogID = randomUUID()
  const original = { catalogID, token: randomUUID() }
  const replacement = { catalogID, token: randomUUID() }
  async function set(marker: Marker) {
    const parent = await client.session.get({ sessionID: parentID })
    await client.session.update({ sessionID: parentID, metadata: { ...parent.metadata, [INHERITANCE_METADATA_KEY]: marker } })
  }
  async function inherited(sessionID: string) {
    const result = await probe.inspect({ sessionID }, { location })
    assert.ok(result.session)
    return result.session.inheritance
  }

  await client.session.update({ sessionID: parentID, metadata: { unrelated: { retained: true } } })
  await set(original)
  // Do not inspect or run the child until the parent has already switched.
  // Event listener speed is deliberately irrelevant to this test.
  const child = await client.session.create({ parentID, title: "Unobserved inheritance child" })
  await set(replacement)
  assert.deepEqual(await inherited(child.id), { status: "valid", marker: original })
  assert.deepEqual(await inherited(parentID), { status: "valid", marker: replacement })
  const grandchild = await client.session.create({ parentID: child.id, title: "Inheritance grandchild" })
  assert.deepEqual(await inherited(grandchild.id), { status: "valid", marker: original })

  await set(original)
  const fork = await client.session.fork({ sessionID: parentID })
  await set(replacement)
  assert.deepEqual(await inherited(fork.id), { status: "valid", marker: original })
  assert.deepEqual((await client.session.get({ sessionID: child.id })).metadata?.unrelated, { retained: true })

  const overridden = await client.session.create({ parentID, title: "Explicit metadata override", metadata: { unrelated: "override" } })
  assert.deepEqual(await inherited(overridden.id), { status: "absent" })
  await client.session.update({ sessionID: overridden.id, metadata: { [INHERITANCE_METADATA_KEY]: { token: "forged" } } })
  assert.deepEqual(await inherited(overridden.id), { status: "invalid" })
  const stale = await client.session.get({ sessionID: parentID })
  await client.session.update({ sessionID: parentID, metadata: { ...stale.metadata, otherWriter: "new value" } })
  await client.session.update({ sessionID: parentID, metadata: { ...stale.metadata, [INHERITANCE_METADATA_KEY]: replacement } })
  assert.equal((await client.session.get({ sessionID: parentID })).metadata?.otherWriter, undefined)
  console.log("PASS native creation/fork metadata snapshots survive later parent switches")
  console.log("CONFIRMED LIMIT: explicit child metadata can replace the inherited marker")
  console.log("CONFIRMED LIMIT: naive full-object metadata updates can overwrite another writer")
  return { parentID, childID: child.id, forkID: fork.id, original, replacement }
}

export async function checkPersistedInheritance(client: Client, directory: string, result: Awaited<ReturnType<typeof checkInheritanceCapability>>) {
  const probe = client.rpc(CapabilityProbe)
  const location = { directory }
  for (const sessionID of [result.childID, result.forkID]) {
    const session = (await probe.inspect({ sessionID }, { location })).session
    assert.deepEqual(session?.inheritance, { status: "valid", marker: result.original })
  }
  assert.deepEqual((await probe.inspect({ sessionID: result.parentID }, { location })).session?.inheritance, { status: "valid", marker: result.replacement })
  console.log("PASS inherited metadata survives private server restart")
}
