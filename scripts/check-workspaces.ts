import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceRPC } from "../src/rpc.ts"
import { createCapabilityFixture, openCodeExecutable, slash, startCapabilityServer } from "../tests/helpers/capability-fixture.ts"
import { openPrivateTui } from "../tests/helpers/private-tui.ts"
import { scriptedProvider } from "../tests/helpers/scripted-provider.ts"

// One end-to-end check of the actual package, after implementation. Reuses the
// existing private transport/provider; there is no second workspace implementation.
const { provider, replies, requests, nativeHold } = scriptedProvider()
let fixture: Awaited<ReturnType<typeof createCapabilityFixture>> | undefined
let host: Awaited<ReturnType<typeof startCapabilityServer>> | undefined
try {
  fixture = await createCapabilityFixture(provider.url.origin)
  const executable = await openCodeExecutable()
  const product = path.join(fixture.base, "workspace-package")
  const build = await Bun.build({ entrypoints: ["index.ts", "tui.ts", "rpc.ts"].map((name) => path.resolve(import.meta.dir, "../src", name)), outdir: product, target: "bun", external: ["@opencode/plugin", "@opencode/plugin/*", "@opentui/core", "@opentui/solid", "@opentui/solid/*", "solid-js", "solid-js/*"] })
  if (!build.success) throw new AggregateError(build.logs, "Workspace package failed to build")
  await fs.writeFile(path.join(product, "package.json"), JSON.stringify({ name: "opencode-workspaces-development", type: "module", exports: { ".": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" } }))
  await fs.symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(product, "node_modules"), "junction")
  // Test harness exposure only. Original executors, schemas, permissions and IDs
  // remain native; the product does not change native Code Mode exposure.
  const overlay = path.join(product, "direct-tools.js")
  await fs.writeFile(overlay, `import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({id:"workspace-development.direct-tools",async setup(ctx){await ctx.tool.transform(editor=>{for(const name of ["read","edit","write","patch","shell"])editor.update(name,tool=>{tool.options={...tool.options,codemode:false}})})}})\n`)
  const configFile = path.join(fixture.launch, "opencode.json")
  const config = await Bun.file(configFile).json()
  config.plugins = [{ package: slash(product), options: { catalogPath: slash(path.join(fixture.base, "workspace-catalog.sqlite")) } }, slash(overlay)]
  await fs.writeFile(configFile, JSON.stringify(config, null, 2))
  host = await startCapabilityServer(executable, fixture)
  const location = { directory: slash(fixture.launch) }
  await host.client.model.list({ location })
  const inventory = await host.client.plugin.list({ location })
  assert.equal(inventory.data.find((plugin) => plugin.id === "workspace-manager.v2")?.state.status, "active", JSON.stringify(inventory))
  const rpc = host.client.rpc(WorkspaceRPC)
  assert.equal((await rpc.state({}, { location })).workspaces.length, 0)
  const ui = await openPrivateTui(executable, fixture, host, "workspace-product")
  try {
    await ui.until("Ask anything")
    await ui.until("[ws:none]")
    ui.send("/workspace")
    await ui.until("Manage workspaces")
    ui.send("\r")
    await ui.until("Create workspace")
    ui.send("Create workspace\r")
    await ui.until("Workspace name")
    ui.send("alpha-demo\r")
    await ui.until("Created alpha-demo")
    ui.send("\r") // Add folder after creation.
    async function addFolder(root: string, finished = "Switch / open workspace") {
      await ui.until("Add current folder")
      ui.send("Paste path manually\r")
      await ui.until("Server folder path")
      ui.send(`${slash(root)}\r`)
      await ui.until("Add current folder")
      ui.send("\r")
      await ui.until("Folder alias")
      ui.send("\r") // Server-generated default alias.
      await ui.until(finished)
    }
    await addFolder(fixture.rootA)
    ui.send("Add folder to saved workspace\r")
    await ui.until("Saved workspaces")
    ui.send("\r")
    await addFolder(fixture.rootB)
    ui.snapshot("real saved workspace with two folders")
    const state = await rpc.state({}, { location })
    assert.equal(state.workspaces[0]?.roots.length, 2)
    assert.equal(requests.length, 0)
    assert.equal((await host.client.session.list({ directory: location.directory })).data.length, 0)
    ui.send("Switch / open workspace\r")
    await ui.until("Saved workspaces")
    ui.send("\r")
    await ui.until("Open in new session")
    ui.send("\r")
    await ui.until("Workspace: alpha-demo")
    await ui.until("[ws:alpha-demo]")
    ui.snapshot("explicitly opened empty workspace session")
    ui.send("DRAFT_WORKSPACE")
    await ui.until("DRAFT_WORKSPACE")
    ui.send("\x10")
    await ui.until("Commands")
    ui.send("Add workspace folder\r")
    // The direct command must target the current saved definition without
    // requiring a second workspace picker, then explicitly apply its new roots.
    await addFolder(fixture.plain, "Folder saved")
    ui.send("\r")
    await ui.screen.until((view) => view.includes("DRAFT_WORKSPACE") && !view.includes("Folder saved") && !view.includes("Add current folder"), "draft after applying saved roots")
    ui.send("_AFTER")
    await ui.until("DRAFT_WORKSPACE_AFTER")
    await ui.resize(64, 24)
    await ui.until("[ws:alpha-demo]")
    ui.snapshot("64-column workspace indicator and preserved editable draft")

    let catalog = await rpc.state({}, { location })
    const betaName = "workspace-beta-very-long-display-name-for-small-terminals"
    catalog = await rpc.change({ requestID: crypto.randomUUID(), expectedRevision: catalog.revision, action: { kind: "create", name: betaName } }, { location })
    const betaID = catalog.workspaces.find((workspace) => workspace.name === betaName)!.id
    const beta = await host.client.session.create({ location, title: "Indicator session B" })
    await rpc.change({ requestID: crypto.randomUUID(), expectedRevision: catalog.revision, sessionID: beta.id, action: { kind: "attach", workspaceID: betaID } }, { location })
    const otherUI = await openPrivateTui(executable, fixture, host, "workspace-second", beta.id)
    try {
      await otherUI.until("[ws:workspace-beta")
      await otherUI.resize(64, 24)
      await otherUI.screen.until((view) => view.includes("[ws:workspace-beta") && view.includes("…") && !view.includes(betaName), "ellipsized workspace name at 64 columns")
      assert.ok(ui.screen.text().includes("[ws:alpha-demo]"), "Another client/session must not retarget this indicator")
      otherUI.snapshot("independent second session with ellipsized long workspace name")
    } finally { await otherUI.close() }
    assert.equal(requests.length, 0)
  } finally { await ui.close() }
  const sessions = (await host.client.session.list({ directory: location.directory })).data
  assert.equal(sessions.length, 2)
  const sessionID = sessions.find((session) => session.title === "Workspace: alpha-demo")!.id
  assert.deepEqual(await host.client.session.context({ sessionID }), [])
  const selected = await rpc.state({ sessionID }, { location })
  assert.equal(selected.binding?.workspace?.roots.length, 3)
  console.log("PASS actual /workspace: create, browse, add two roots, explicitly open empty session; zero provider requests")
  console.log("PASS actual indicator: independent sessions, narrow-terminal ellipsis, direct add/apply, and preserved editable draft")
  const roots = [fixture.rootA, fixture.rootB]
  replies.push(
    roots.map((root) => ({ name: "read", input: { path: slash(path.join(root, "src/answer.mjs")) } })),
    roots.map((root) => ({ name: "edit", input: { path: slash(path.join(root, "src/answer.mjs")), oldString: "answer = 1", newString: "answer = 3" } })),
    roots.flatMap((root) => [{ name: "shell", input: { command: "node --test", workdir: slash(root) } }, { name: "shell", input: { command: "git status --short", workdir: slash(root) } }]),
    [{ name: "write", input: { path: slash(path.join(fixture.rootA, ".env.fixture")), content: "must not be created" } }], [],
  )
  await host.client.session.prompt({ sessionID, text: "Make and verify the controlled change across both workspace repositories." })
  await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90_000) })
  assert.equal(replies.length, 0)
  for (const root of roots) assert.equal(await fs.readFile(path.join(root, "src/answer.mjs"), "utf8"), "export const answer = 3\n")
  assert.equal(await fs.exists(path.join(fixture.rootA, ".env.fixture")), false)
  const transcript = await host.client.session.context({ sessionID })
  const tools = transcript.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
  assert.equal(tools.filter((tool) => tool.state.status === "error").length, 1, JSON.stringify(tools))
  for (const tool of tools.filter((tool) => tool.name === "shell")) {
    assert.equal(tool.state.status, "completed", JSON.stringify(tool))
    if (tool.state.status === "completed") assert.equal(tool.state.metadata?.exit, 0, JSON.stringify(tool))
  }
  assert.match(JSON.stringify(requests[1]), /ROOT_A_RULE_MARKER_NESTED/)
  assert.match(JSON.stringify(requests[1]), /ROOT_B_RULE_MARKER_NESTED/)
  let state = await rpc.state({ sessionID }, { location })
  assert.equal(state.binding?.sealed, true)
  await assert.rejects(rpc.change({ requestID: crypto.randomUUID(), expectedRevision: state.revision, sessionID, action: { kind: "detach" } }, { location }), { type: "workspace", data: { code: "SESSION_STARTED" } })
  state = await rpc.change({ requestID: crypto.randomUUID(), expectedRevision: state.revision, action: { kind: "removeRoot", workspaceID: state.workspaces[0]!.id, alias: state.workspaces[0]!.roots[0]!.alias } }, { location })
  assert.equal((await rpc.state({ sessionID }, { location })).binding?.workspace?.roots.length, 3)
  console.log("PASS actual plugin: scoped instructions, two native edits, both test suites/Git, sensitive-path rejection, sealed selection and pinned roots")
  const betaSessionID = sessions.find((session) => session.title === "Indicator session B")!.id
  await host.client.session.switchModel({ sessionID: betaSessionID, model: { providerID: "workspace-fixture", id: "fixture-small" } })
  const blockedUI = await openPrivateTui(executable, fixture, host, "workspace-blocked", betaSessionID)
  try {
    await blockedUI.until("[ws:workspace-beta")
    replies.push([])
    await host.client.session.prompt({ sessionID: betaSessionID, text: "Show the unsupported instruction-budget state; do not call tools." })
    await host.client.session.wait({ sessionID: betaSessionID }, { signal: AbortSignal.timeout(30_000) })
    await blockedUI.until("!]")
    assert.equal((await rpc.selection({ sessionID: betaSessionID }, { location })).instructions, "blocked")
    assert.equal((await rpc.selection({ sessionID }, { location })).instructions, "ready")
    blockedUI.snapshot("blocked instruction budget is visible without changing another session's status")
  } finally { await blockedUI.close() }
  console.log("PASS actual indicator: blocked instruction budget is visible and session-scoped")
  await host.stop()
  host = await startCapabilityServer(executable, fixture)
  await host.client.model.list({ location })
  const restored = await host.client.rpc(WorkspaceRPC).state({ sessionID }, { location })
  assert.equal(restored.binding?.sealed, true)
  assert.equal(restored.binding?.workspace?.roots.length, 3)
  assert.equal(restored.workspaces[0]?.roots.length, 2)
  console.log("PASS actual catalog and pinned session survive private-server restart")
  await fs.writeFile(path.join(fixture.base, "working-plugin-results.json"), JSON.stringify({ passed: true, implementation: "src/index.ts + src/tui.ts", sessionID, adminProviderRequests: 0, modelRequests: requests.length, restored }, null, 2))
  await fs.writeFile(path.join(fixture.base, "working-plugin-transcript.json"), JSON.stringify(transcript, null, 2))
} finally {
  if (fixture) await fs.writeFile(path.join(fixture.base, "provider-requests.json"), JSON.stringify(requests, null, 2))
  nativeHold.release.resolve([])
  try { await host?.stop() } finally { await provider.stop(true) }
  if (fixture) console.log(`Retained working-plugin fixture: ${fixture.base}`)
}
