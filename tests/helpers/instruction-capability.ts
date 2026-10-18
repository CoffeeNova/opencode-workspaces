import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import type { OpenCode } from "@opencode/client"
import { InstructionProbe } from "../fixtures/phase-zero-plugin/instruction-rpc.ts"
import type { InstructionSnapshot } from "../fixtures/phase-zero-plugin/instructions.ts"
import { slash, type createCapabilityFixture } from "./capability-fixture.ts"
import { heldReply, type ScriptedCall, type ScriptedReply } from "./lifecycle-capability.ts"

type Client = ReturnType<typeof OpenCode.make>
type Fixture = Awaited<ReturnType<typeof createCapabilityFixture>>
function capturedSnapshot(request: unknown): InstructionSnapshot {
  const strings = (value: unknown): string[] => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
    : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : []
  const messages = (request as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role === "system")
  const marker = "WORKSPACE_INSTRUCTION_PROBE\n"
  const blocks = strings(messages).filter((text) => text.includes(marker))
  assert.equal(blocks.length, 1, "Exactly one fresh workspace instruction block must reach the provider")
  const json = blocks[0]!.slice(blocks[0]!.indexOf(marker) + marker.length).split("\n")[0]!
  return JSON.parse(json) as InstructionSnapshot
}

export async function checkInstructionCapability(client: Client, fixture: Fixture, requests: unknown[], enqueue: (reply: ScriptedReply) => void) {
  const location = { directory: slash(fixture.launch) }
  const checks: string[] = []
  const sessions: string[] = []
  const start = requests.length
  const rootRule = path.join(fixture.rootA, "AGENTS.md")
  const nestedRule = path.join(fixture.rootA, "src", "AGENTS.md")
  const bRule = path.join(fixture.rootB, "AGENTS.md")
  const originals = await Promise.all([rootRule, nestedRule, bRule].map((file) => fs.readFile(file, "utf8")))
  const file = (root: string, relative: string) => slash(path.join(root, relative))
  const write = (target: string, content = "instruction-aware write\n"): ScriptedCall => ({ name: "write", input: { path: target, content } })
  async function session(roots: "both" | "a" | "overlap" = "both", model = "fixture-coder") {
    const created = await client.session.create({ location, title: "Disposable instruction proof" })
    sessions.push(created.id)
    await client.rpc(InstructionProbe).activate({ sessionID: created.id, roots }, { location })
    if (model !== "fixture-coder") await client.session.switchModel({ sessionID: created.id, model: { providerID: "workspace-fixture", id: model } })
    return created.id
  }
  async function calls(sessionID: string) {
    return (await client.session.context({ sessionID })).flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
  }
  async function run(sessionID: string, batches: ScriptedCall[][]) {
    const before = (await calls(sessionID)).length
    const requestStart = requests.length
    for (const batch of [...batches, []]) enqueue(batch)
    await client.session.prompt({ sessionID, text: "Execute this isolated instruction-delivery acceptance case." })
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) })
    assert.equal(requests.length - requestStart, batches.length + 1, "Every scripted instruction continuation must reach the provider")
    return { parts: (await calls(sessionID)).slice(before), snapshots: requests.slice(requestStart).map(capturedSnapshot) }
  }
  const completed = (parts: Awaited<ReturnType<typeof calls>>) => {
    assert.ok(parts.length)
    for (const part of parts) assert.equal(part.state.status, "completed", JSON.stringify(part))
  }
  const rejected = (parts: Awaited<ReturnType<typeof calls>>, code: string) => {
    assert.ok(parts.length)
    for (const part of parts) {
      assert.equal(part.state.status, "error", JSON.stringify(part))
      if (part.state.status === "error") assert.ok(part.state.error.message.includes(code), JSON.stringify(part))
    }
  }
  const check = (name: string) => { checks.push(name); console.log(`PASS instructions: ${name}`) }
  try {
    const both = await session()
    const result = await run(both, [[write(file(fixture.rootA, "instruction-root.txt")), write(file(fixture.rootB, "instruction-root.txt"))]])
    completed(result.parts)
    const initial = result.snapshots[0]!
    assert.deepEqual(initial.roots.map((root) => root.alias), ["a", "b"])
    assert.equal(initial.sources.length, 2)
    assert.equal(initial.sources.find((source) => source.scope === fixture.rootA)?.content, originals[0])
    assert.equal(initial.sources.find((source) => source.scope === fixture.rootB)?.content, originals[2])
    assert.match(JSON.stringify(requests[start]), /LAUNCH_RULE_MARKER/, "Native launch instructions must be preserved")
    const onlyA = await run(await session("a"), [])
    assert.equal(onlyA.snapshots[0]!.sources.length, 1)
    assert.doesNotMatch(JSON.stringify(onlyA.snapshots[0]), /ROOT_B_RULE_MARKER|NESTED/)
    check("both external root bodies/scopes reach real requests; session A-only does not receive B")

    const parallel = await session()
    const parallelFile = file(fixture.rootA, "src/instruction-parallel.txt")
    const parallelResult = await run(parallel, [[{ name: "read", input: { path: file(fixture.rootA, "src/answer.mjs") } }, write(parallelFile)]])
    completed(parallelResult.parts.filter((part) => part.name === "read"))
    rejected(parallelResult.parts.filter((part) => part.name === "write"), "INSTRUCTIONS_REQUIRED")
    assert.equal(await fs.exists(parallelFile), false)
    assert.equal(parallelResult.snapshots[0]!.sources.some((source) => source.path === nestedRule), false)
    assert.equal(parallelResult.snapshots[1]!.sources.find((source) => source.path === nestedRule)?.content, originals[1])
    completed((await run(parallel, [[write(parallelFile)]])).parts)
    assert.equal(await fs.readFile(parallelFile, "utf8"), "instruction-aware write\n")
    completed((await run(parallel, [[{ name: "edit", input: { path: parallelFile, oldString: "instruction-aware write", newString: "instruction-aware edit" } }]])).parts)
    assert.equal(await fs.readFile(parallelFile, "utf8"), "instruction-aware edit\n")
    check("parallel read/write rejects first-touch mutation; regenerated write/edit succeed after delivery")

    const patchSession = await session("both", "gpt-5.2")
    const aFile = file(fixture.rootA, "instruction-root.txt")
    const bNested = file(fixture.rootB, "src/instruction-patch.txt")
    const patch = `*** Begin Patch\n*** Update File: ${aFile}\n@@\n-instruction-aware write\n+partial mutation forbidden\n*** Add File: ${bNested}\n+undelivered\n*** End Patch`
    rejected((await run(patchSession, [[{ name: "patch", input: { patchText: patch } }]])).parts, "INSTRUCTIONS_REQUIRED")
    assert.equal(await fs.readFile(aFile, "utf8"), "instruction-aware write\n")
    assert.equal(await fs.exists(bNested), false)
    check("multi-root native patch preflights every target before the first side effect")

    const renameSession = await session("both", "gpt-5.2")
    const from = file(fixture.rootA, "instruction-rename.txt")
    const to = file(fixture.rootB, "src/instruction-renamed.txt")
    await fs.writeFile(from, "before\n")
    const rename = { name: "patch", input: { patchText: `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-before\n+after\n*** End Patch` } }
    rejected((await run(renameSession, [[rename]])).parts, "INSTRUCTIONS_REQUIRED")
    assert.equal(await fs.readFile(from, "utf8"), "before\n")
    assert.equal(await fs.exists(to), false)
    completed((await run(renameSession, [[rename]])).parts)
    assert.equal(await fs.exists(from), false)
    assert.equal(await fs.readFile(to, "utf8"), "after\n")
    check("native rename validates source and destination scopes before removal/creation")

    const stalePatchHold = heldReply()
    const stalePatchBefore = (await calls(patchSession)).length
    const staleBRule = path.join(fixture.rootB, "src", "AGENTS.md")
    const originalBRule = await fs.readFile(staleBRule, "utf8")
    enqueue(stalePatchHold)
    enqueue([])
    const staleTimer = setTimeout(() => stalePatchHold.entered.reject(new Error("Stale patch hold did not start")), 15_000)
    try {
      await client.session.prompt({ sessionID: patchSession, text: "Hold this two-root patch while the second target's instructions change." })
      await stalePatchHold.entered.promise
      await fs.writeFile(staleBRule, "ROOT_B_CHANGED_NESTED: changed after patch generation.\n")
      stalePatchHold.release.resolve([{ name: "patch", input: { patchText: patch } }])
      await client.session.wait({ sessionID: patchSession }, { signal: AbortSignal.timeout(30_000) })
      rejected((await calls(patchSession)).slice(stalePatchBefore), "INSTRUCTIONS_REQUIRED")
      assert.equal(await fs.readFile(aFile, "utf8"), "instruction-aware write\n")
      assert.equal(await fs.exists(bNested), false)
    } finally {
      clearTimeout(staleTimer)
      stalePatchHold.release.resolve([])
      await fs.writeFile(staleBRule, originalBRule)
    }
    check("a stale second target rejects an entire already-generated patch without changing its valid first target")

    for (const content of ["ROOT_A_CHANGED_NESTED: replacement rules.\n", undefined]) {
      const hold = heldReply()
      const before = (await calls(parallel)).length
      const requestStart = requests.length
      const target = file(fixture.rootA, `src/instruction-${content ? "changed" : "deleted"}.txt`)
      enqueue(hold)
      enqueue([])
      const timer = setTimeout(() => hold.entered.reject(new Error("Instruction stale-request hold did not start")), 15_000)
      try {
        await client.session.prompt({ sessionID: parallel, text: "Hold this generated mutation while its scoped instructions change." })
        await hold.entered.promise
        assert.equal(capturedSnapshot(requests[requestStart]).sources.find((source) => source.path === nestedRule)?.status, "loaded")
        if (content) await fs.writeFile(nestedRule, content)
        else await fs.unlink(nestedRule)
      } finally { clearTimeout(timer); hold.release.resolve([write(target)]) }
      await client.session.wait({ sessionID: parallel }, { signal: AbortSignal.timeout(30_000) })
      rejected((await calls(parallel)).slice(before), "INSTRUCTIONS_REQUIRED")
      assert.equal(await fs.exists(target), false)
      const refreshed = capturedSnapshot(requests[requestStart + 1])
      const source = refreshed.sources.find((source) => source.path === nestedRule)
      assert.equal(source?.status, content ? "loaded" : "missing")
      assert.equal(source?.content, content)
      completed((await run(parallel, [[write(target)]])).parts)
    }
    check("changed/deleted rules reject an already generated write; fresh requests explicitly supersede old text")
    await fs.writeFile(nestedRule, originals[1]!)

    const overlapping = await run(await session("overlap"), [[write(file(fixture.rootA, "src/instruction-overlap.txt"))]])
    completed(overlapping.parts)
    assert.equal(overlapping.snapshots[0]!.sources.filter((source) => source.path === nestedRule).length, 1)
    assert.equal(overlapping.snapshots[0]!.sources.filter((source) => source.path === rootRule).length, 1)
    check("overlapping registered roots deduplicate sources without losing ancestor scope")

    const denied = await session("a")
    await client.session.update({ sessionID: denied, permissions: [{ action: "read", resource: slash(rootRule), effect: "deny" }] })
    const beforeDeny = requests.length
    await client.session.prompt({ sessionID: denied, text: "This instruction source is denied; no provider call is permitted." })
    await client.session.wait({ sessionID: denied }, { signal: AbortSignal.timeout(30_000) })
    assert.equal(requests.length, beforeDeny, "Denied instruction content must never reach a provider")
    const deniedMessages = await client.session.context({ sessionID: denied })
    const deniedIdle = deniedMessages.find((message) => message.type === "idle")
    assert.ok(deniedIdle?.type === "idle")
    assert.equal(deniedIdle.outcome, "failed")
    assert.equal(deniedIdle.error?.type, "permission.rejected", "Missing provider dispatch must be the native permission failure, not an unrelated setup error")
    assert.doesNotMatch(JSON.stringify(deniedMessages), /ROOT_A_RULE_MARKER/)
    check("native instruction read denial propagates before any provider dispatch")

    await fs.writeFile(rootRule, "FILE_OVERFLOW_MUST_NOT_BE_DELIVERED\n" + "x".repeat(32 * 1024))
    const overflowTarget = file(fixture.rootA, "instruction-overflow.txt")
    const overflow = await run(await session("a"), [[write(overflowTarget)]])
    rejected(overflow.parts, "INSTRUCTIONS_UNAVAILABLE")
    assert.equal(await fs.exists(overflowTarget), false)
    assert.ok(overflow.snapshots[0]!.errors.some((error) => error.includes("File exceeds")))
    assert.doesNotMatch(JSON.stringify(overflow.snapshots), /FILE_OVERFLOW_MUST_NOT_BE_DELIVERED/)
    await fs.writeFile(rootRule, "a".repeat(22_000))
    await fs.writeFile(bRule, "b".repeat(22_000))
    await fs.writeFile(nestedRule, "c".repeat(22_000))
    const aggregateTarget = file(fixture.rootA, "src/instruction-aggregate.txt")
    const aggregate = await run(await session(), [[{ name: "read", input: { path: file(fixture.rootA, "src/answer.mjs") } }], [write(aggregateTarget)]])
    completed(aggregate.parts.filter((part) => part.name === "read"))
    rejected(aggregate.parts.filter((part) => part.name === "write"), "INSTRUCTIONS_UNAVAILABLE")
    assert.equal(await fs.exists(aggregateTarget), false)
    assert.ok(aggregate.snapshots[1]!.errors.some((error) => error.includes("Aggregate instructions")))
    assert.ok(aggregate.snapshots[1]!.sources.every((source) => source.content === undefined))
    check("32 KiB file/64 KiB aggregate overflow is visible and blocks writes without partial-rule delivery")
    for (const [index, source] of [rootRule, nestedRule, bRule].entries()) await fs.writeFile(source, originals[index]!)

    const smallTarget = file(fixture.rootA, "instruction-small.txt")
    const small = await run(await session("a", "fixture-small"), [[write(smallTarget)]])
    rejected(small.parts, "INSTRUCTIONS_UNAVAILABLE")
    assert.equal(await fs.exists(smallTarget), false)
    assert.ok(small.snapshots[0]!.errors.some((error) => error.includes("budget policy is unverified")))
    assert.ok(small.snapshots[0]!.sources.every((source) => source.content === undefined))
    check("declared 8k context fails closed; byte caps are not claimed to be token-budget validation")

    const observations = (await fs.readFile(path.join(fixture.base, "observations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; data: { id?: string; sessionID?: string; requestID?: string; sources?: Record<string, unknown>[] } })
    const preflights = observations.filter((item) => item.kind === "instructions.preflight" && sessions.includes(item.data.sessionID!))
    assert.ok(preflights.length)
    for (const item of preflights) {
      const index = Number(/^call_fixture_(\d+)_/.exec(item.data.id!)?.[1]) - 1
      assert.equal(item.data.requestID, capturedSnapshot(requests[index]).requestID, "A successful preflight must reference its actual generating request, not a later capture")
    }
    for (const item of observations.filter((item) => item.kind === "instructions.capture")) {
      assert.ok(item.data.sources?.every((source) => !Object.hasOwn(source, "content")), "Fingerprint diagnostics must not contain instruction bodies")
    }
    check("successful native preflights correlate with their exact captured provider request; diagnostics omit source bodies")

    return { checks, sessions, modelRequests: requests.length - start, limitations: ["fixed-fixture-session-mapping-not-bindings", "small-model-token-budget-policy-unverified", "no-concurrent-request-replay-or-filesystem-transaction-proof", "permission-wait-instruction-freshness-unverified", "compaction-revert-restart-adapters-not-runtime-verified", "conservative-patch-grammar-subset"] }
  } finally {
    for (const [index, source] of [rootRule, nestedRule, bRule].entries()) await fs.writeFile(source, originals[index]!)
    await fs.writeFile(path.join(fixture.base, "instruction-transcripts.json"), JSON.stringify(await Promise.all(sessions.map(async (sessionID) => ({ sessionID, messages: await client.session.context({ sessionID }) }))), null, 2))
  }
}
