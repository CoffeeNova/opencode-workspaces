import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { BoundaryProbe, CapabilityProbe } from "./fixtures/phase-zero-plugin/rpc.ts"
import { CAPABILITY_RUNTIME, CAPABILITY_SDK, createCapabilityFixture, openCodeExecutable, slash, startCapabilityServer } from "./helpers/capability-fixture.ts"
import { checkTuiCapability } from "./helpers/tui-capability.ts"
import { checkJournalCapability } from "./helpers/journal-capability.ts"
import { checkIdleWaitCapability, checkInheritanceCapability, checkPersistedInheritance, checkToolBoundaryCapability } from "./helpers/lifecycle-capability.ts"
import { checkInstructionCapability } from "./helpers/instruction-capability.ts"
import { scriptedProvider } from "./helpers/scripted-provider.ts"

// Opt-in: a real private server with a deterministic loopback-only provider.
// Provider replies generate native tool calls; executors never receive fake IDs.
const { provider, replies, requests, nativeHold } = scriptedProvider()
let fixture: Awaited<ReturnType<typeof createCapabilityFixture>> | undefined
let host: Awaited<ReturnType<typeof startCapabilityServer>> | undefined
let passed = false
try {
  const executable = await openCodeExecutable()
  fixture = await createCapabilityFixture(provider.url.origin)
  host = await startCapabilityServer(executable, fixture)
  const { client } = host
  const location = { directory: slash(fixture.launch) }
  await client.model.list({ location })
  const plugins = await client.plugin.list({ location })
  const ours = plugins.data.filter((plugin) => plugin.id === "workspace-manager.capability-probe")
  assert.equal(ours.length, 1, "Server package loads exactly once")
  assert.equal(ours[0]?.state.status, "active", JSON.stringify(ours))
  assert.equal(ours[0]?.features.tui, true, "Package ./tui export is discovered")
  const unexpected = plugins.data.filter((plugin) => !plugin.id?.startsWith("opencode.") && !plugin.id?.startsWith("workspace-manager.capability-probe"))
  assert.deepEqual(unexpected, [], "No user/global/system plugins may enter the fixture")
  const probe = client.rpc(CapabilityProbe)
  const initial = await probe.inspect({}, { location })
  assert.equal(initial.runtimeVersion, CAPABILITY_RUNTIME)
  assert.equal(initial.session, undefined)
  const a = await client.session.create({ location, title: "Phase zero A" })
  const b = await client.session.create({ location, title: "Phase zero B" })
  assert.equal((await probe.inspect({ sessionID: a.id }, { location })).session?.id, a.id)
  assert.equal((await probe.inspect({ sessionID: b.id }, { location })).instanceID, initial.instanceID)
  const child = await client.session.create({ parentID: a.id, title: "Phase zero child" })
  assert.equal((await probe.inspect({ sessionID: child.id }, { location })).session?.parentID, a.id)
  const wrong = await client.session.create({ location: { directory: slash(fixture.other) }, title: "Other Location" })
  await assert.rejects(probe.inspect({ sessionID: wrong.id }, { location }), { type: "location_mismatch" })
  await assert.rejects(probe.inspect({ sessionID: "ses_missing_fixture" }, { location }))
  await assert.rejects(probe.inspect({ sessionID: "not-a-session" }, { location }))
  assert.equal(requests.length, 0, "Metadata RPC never requests a model")
  assert.deepEqual(await client.session.context({ sessionID: a.id }), [])
  console.log("PASS package loader + typed RPC + session/Location validation (no model calls)")
  let tui: Awaited<ReturnType<typeof checkTuiCapability>> | undefined
  if (process.argv.includes("--tui")) {
    tui = await checkTuiCapability(executable, fixture, host)
    assert.equal(requests.length, 0, "Real TUI management must not request a model")
    assert.deepEqual(await client.session.context({ sessionID: a.id }), [], "TUI management must not create synthetic conversation turns")
  }

  const rootFiles = [fixture.rootA, fixture.rootB].map((root) => slash(path.join(root, "src", "answer.mjs")))
  const blocked = slash(path.join(fixture.rootA, "blocked.txt"))
  replies.push(
    [
      ...rootFiles.map((file) => ({ name: "read", input: { path: file } })),
      { name: "write", input: { path: slash(path.join(fixture.rootB, "parallel.txt")), content: "parallel request snapshot\n" } },
    ],
    rootFiles.map((file) => ({ name: "edit", input: { path: file, oldString: "answer = 1", newString: "answer = 2" } })),
    [fixture.rootA, fixture.rootB].map((root) => ({ name: "write", input: { path: slash(path.join(root, "created", "note.txt")), content: "native write\n" } })),
    [{ name: "write", input: { path: slash(path.join(fixture.rootA, "formatted.probe")), content: "native format\n" } }],
    [{ name: "write", input: { path: blocked, content: "must not be written" } }],
    [],
  )
  await client.session.prompt({ sessionID: a.id, text: "Run the disposable read/edit/write capability fixture." })
  await client.session.wait({ sessionID: a.id }, { signal: AbortSignal.timeout(90_000) })
  assert.equal(replies.length, 0, "All scripted read/edit/write steps must execute")
  for (const file of rootFiles) assert.equal(await fs.readFile(file, "utf8"), "export const answer = 2\n")
  assert.equal(await fs.exists(blocked), false, "execute.before failure prevents write side effects")
  await client.session.switchModel({ sessionID: a.id, model: { providerID: "workspace-fixture", id: "gpt-5.2" } })
  replies.push(
    [{ name: "patch", input: { patchText: `*** Begin Patch\n${rootFiles.map((file) => `*** Update File: ${file}\n@@\n-export const answer = 2\n+export const answer = 3`).join("\n")}\n*** End Patch` } }],
    [fixture.rootA, fixture.rootB].flatMap((root) => [
      { name: "shell", input: { command: "node --test", workdir: slash(root), timeout: 30_000 } },
      { name: "shell", input: { command: "git status --short", workdir: slash(root), timeout: 30_000 } },
    ]),
    [{ name: "patch", input: { patchText: `*** Begin Patch\n*** Update File: ${rootFiles[0]}\n@@\n-export const answer = 3\n+export const answer = 999\n*** Add File: ${blocked}\n+must not be written\n*** End Patch` } }],
    [],
  )
  await client.session.prompt({ sessionID: a.id, text: "Run the disposable patch/shell capability fixture." })
  await client.session.wait({ sessionID: a.id }, { signal: AbortSignal.timeout(90_000) })
  const transcript = await client.session.context({ sessionID: a.id })
  await fs.writeFile(path.join(fixture.base, "transcript.json"), JSON.stringify(transcript, null, 2))
  assert.equal(replies.length, 0, "All scripted native-tool steps must execute")
  for (const file of rootFiles) assert.equal(await fs.readFile(file, "utf8"), "export const answer = 3\n")
  for (const root of [fixture.rootA, fixture.rootB]) assert.equal(await fs.readFile(path.join(root, "created", "note.txt"), "utf8"), "native write\n")
  assert.equal(await fs.exists(blocked), false, "execute.before failure prevents side effects")
  assert.equal(await fs.readFile(path.join(fixture.rootB, "parallel.txt"), "utf8"), "parallel request snapshot\n")
  console.log("PASS native read/edit/write/patch in two external repositories + hook rejection")
  const toolParts = transcript.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
  const errors = toolParts.filter((part) => part.state.status === "error")
  assert.equal(errors.length, 2, JSON.stringify(errors))
  for (const part of errors) {
    assert.equal(part.state.status, "error")
    if (part.state.status === "error") assert.match(part.state.error.message, /PHASE_ZERO_BLOCKED/)
  }
  const shells = toolParts.filter((part) => part.name === "shell")
  assert.equal(shells.length, 4)
  for (const [index, part] of shells.entries()) {
    assert.equal(part.state.status, "completed", JSON.stringify(part))
    if (part.state.status === "completed") {
      assert.equal(part.state.metadata?.exit, 0, "Each repository's tests/Git command must succeed")
      const output = JSON.stringify(part.state.content)
      if (index % 2 === 0) assert.match(output, /# pass 1/, "Each external suite must actually execute its test")
      else assert.match(output, /src\/answer\.mjs/, "Git must report the external repository's edit, not the launch repository")
    }
  }
  assert.equal(await fs.readFile(path.join(fixture.rootA, "formatted.probe"), "utf8"), "native format\nFORMATTED\n")
  const formatter = JSON.parse((await fs.readFile(path.join(fixture.base, "formatter-runs.jsonl"), "utf8")).trim()) as { cwd: string }
  assert.equal(slash(await fs.realpath(formatter.cwd)), slash(fixture.launch), "External formatting runs in the launch Location, not the external repository")
  console.log("PASS explicit-workdir tests/Git + external formatting (launch-Location formatter)")

  for (const request of requests) {
    const assembled = JSON.stringify(request)
    assert.match(assembled, /LAUNCH_RULE_MARKER/)
    assert.match(assembled, /PHASE_ZERO_CONTEXT/)
    assert.doesNotMatch(assembled, /ROOT_[AB]_RULE_MARKER/, "Native external reads did not deliver external AGENTS.md")
  }
  console.log("CONFIRMED LIMIT: native external reads do not discover root/nested AGENTS.md")
  assert.deepEqual(await client.session.diff({ sessionID: a.id }), [], "External edits are absent from session snapshot diffs")
  const firstUser = transcript.find((message) => message.type === "user")
  assert.ok(firstUser)
  await client.session.revert.stage({ sessionID: a.id, messageID: firstUser.id, files: true })
  for (const file of rootFiles) assert.equal(await fs.readFile(file, "utf8"), "export const answer = 3\n", "Native undo does not restore external edits")
  await client.session.revert.clear({ sessionID: a.id })
  console.log("CONFIRMED LIMIT: native snapshot/revert excludes the external repositories")

  const fork = await client.session.fork({ sessionID: a.id })
  const forkStatus = await probe.inspect({ sessionID: fork.id }, { location })
  assert.equal(forkStatus.session?.forkSessionID, a.id)
  console.log("PASS public child/fork ancestry metadata (journal validation follows below)")

  const deniedFile = slash(path.join(fixture.rootA, "denied.txt"))
  const sensitiveFile = slash(path.join(fixture.rootA, ".env.fixture"))
  await fs.writeFile(sensitiveFile, "FIXTURE_SECRET_MUST_NOT_REACH_PROVIDER")
  await client.session.update({ sessionID: b.id, permissions: [
    { action: "external_directory", resource: "*", effect: "allow" },
    { action: "edit", resource: deniedFile, effect: "deny" },
    { action: "read", resource: sensitiveFile, effect: "deny" },
    { action: "workspace_probe_metadata", resource: "*", effect: "deny" },
  ] })
  await assert.rejects(probe.inspect({ sessionID: b.id }, { location }), "RPC permission denial must reject, not return fake success")
  replies.push(
    [{ name: "write", input: { path: deniedFile, content: "must not be written" } }],
    [{ name: "read", input: { path: sensitiveFile } }],
    [],
  )
  await client.session.prompt({ sessionID: b.id, text: "Run the disposable denied-permission fixture." })
  await client.session.wait({ sessionID: b.id }, { signal: AbortSignal.timeout(30_000) })
  const deniedTranscript = await client.session.context({ sessionID: b.id })
  const deniedCalls = deniedTranscript.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
  assert.equal(deniedCalls.length, 2)
  for (const part of deniedCalls) assert.equal(part.state.status, "error", JSON.stringify(part))
  assert.equal(await fs.exists(deniedFile), false)
  assert.doesNotMatch(JSON.stringify(requests), /FIXTURE_SECRET_MUST_NOT_REACH_PROVIDER/)
  console.log("PASS native edit/read deny after external allow + source-free RPC permission assertion")

  // Flush preceding hook observations through the same serialized trace writer.
  await probe.inspect({ sessionID: a.id }, { location })
  type Observation = { kind: string; data: {
    id?: string; sessionID?: string; tool?: string; action?: string; source?: { id?: string }; type?: string
    error?: { error?: { _tag?: string; permission?: string; resources?: string[] } }
  } }
  const observations = (await fs.readFile(path.join(fixture.base, "observations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Observation)
  for (const part of toolParts.filter((part) => part.state.status === "completed")) {
    const before1 = observations.findIndex((item) => item.kind === "tool.before.1" && item.data.id === part.id)
    const before2 = observations.findIndex((item) => item.kind === "tool.before.2" && item.data.id === part.id)
    const after = observations.findIndex((item) => item.kind === "tool.after" && item.data.id === part.id)
    assert.ok(before1 >= 0 && before1 < before2 && before2 < after, `Native hook ordering for ${part.name}`)
  }
  for (const part of errors) {
    assert.ok(observations.some((item) => item.kind === "tool.before.1" && item.data.id === part.id))
    assert.equal(observations.some((item) => item.kind === "tool.before.2" && item.data.id === part.id), false)
    assert.equal(observations.some((item) => item.kind === "permission" && item.data.source?.id === part.id), false)
    // Important for future lease cleanup: after does NOT run if before throws.
    assert.equal(observations.some((item) => item.kind === "tool.after" && item.data.id === part.id), false)
  }
  assert.ok(observations.some((item) => item.kind === "permission" && item.data.action === "workspace_probe_metadata" && item.data.source === undefined))
  for (const part of deniedCalls) {
    const failure = observations.find((item) => item.kind === "tool.after" && item.data.id === part.id)?.data.error?.error
    assert.equal(failure?._tag, "Permission.BlockedError", "The error must be a native configured denial, not a missing-tool failure")
    assert.equal(failure.permission, part.name === "write" ? "edit" : "read")
    assert.deepEqual(failure.resources, [part.name === "write" ? deniedFile : sensitiveFile])
    // Configured denies short-circuit evaluate; the structured error is evidence.
    assert.equal(observations.some((item) => item.kind === "permission" && item.data.action === failure.permission && item.data.source?.id === part.id), false)
  }
  console.log("PASS ordered hooks + all-target patch rejection; before failure has no after callback")
  const instructions = await checkInstructionCapability(client, fixture, requests, (reply) => { replies.push(reply) })
  assert.equal(replies.length, 0)
  await fs.writeFile(path.join(fixture.base, "instruction-results.json"), JSON.stringify(instructions, null, 2))
  await checkIdleWaitCapability(client, location.directory, a.id, child.id, (reply) => { replies.push(reply) })
  await checkToolBoundaryCapability(client, location.directory, a.id, slash(fixture.rootA), provider.url.origin, (reply) => { replies.push(reply) }, nativeHold)
  const inheritance = await checkInheritanceCapability(client, location.directory, a.id)
  const boundaryBeforeRestart = await client.rpc(BoundaryProbe).status({}, { location })
  await host.stop()
  host = undefined
  host = await startCapabilityServer(executable, fixture)
  await host.client.model.list({ location })
  assert.notEqual((await host.client.rpc(CapabilityProbe).inspect({}, { location })).instanceID, initial.instanceID)
  assert.deepEqual(await host.client.rpc(BoundaryProbe).status({}, { location }), boundaryBeforeRestart)
  await checkPersistedInheritance(host.client, location.directory, inheritance)
  const modelRequestsBeforeJournal = requests.length
  const journal = await checkJournalCapability(host.client, fixture, fork.id, async () => {
    await host!.stop()
    host = undefined
    host = await startCapabilityServer(executable, fixture!)
    return host.client
  })
  assert.equal(requests.length, modelRequestsBeforeJournal, "Journal administration and restart recovery must not request a model")
  await fs.writeFile(path.join(fixture.base, "capability-results.json"), JSON.stringify({
    runtime: CAPABILITY_RUNTIME, sdk: CAPABILITY_SDK, bun: Bun.version, platform: process.platform,
    realTui: process.argv.includes("--tui"), tui, provider: "scripted-loopback-only", modelRequests: requests.length,
    lifecyclePrimitives: ["native-inherited-metadata-snapshot", "persistent-child-fork-marker", "cancellable-effect-idle-wait", "guarded-epoch-commit", "native-tool-permit-interruption", "disposable-sqlite-journal-restart-recovery"],
    journal, instructions,
    limits: ["no-native-external-instructions", "no-external-snapshot-revert", "formatter-uses-launch-location", "no-after-hook-for-before-failure", "configured-deny-skips-evaluate-hook", "child-metadata-override-can-drop-inheritance-marker", "full-metadata-replacement-can-lose-updates", "promise-adapter-ignores-wait-abort-signal", ...journal.limitations],
    openGates: ["atomic-inheritance-publication-and-metadata-override-authentication", "catalog-wide-session-derivation-and-gate-integration", "real-model-instruction-budgets", "tui-full-administration-indicator-reconnect-and-dialog-ownership"],
  }, null, 2))
  passed = true
} finally {
  try {
    if (fixture) await fs.writeFile(path.join(fixture.base, "provider-requests.json"), JSON.stringify({ sdk: CAPABILITY_SDK, requests }, null, 2))
  } finally {
    nativeHold.release.resolve([])
    try { await host?.stop() } finally { await provider.stop(true) }
  }
  if (fixture && passed && !process.argv.includes("--keep")) await fs.rm(fixture.base, { recursive: true, force: true })
  else if (fixture) console.log(`Retained disposable fixture: ${fixture.base}`)
}
