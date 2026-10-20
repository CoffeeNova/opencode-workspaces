import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { WorkspaceRPC } from "../src/rpc.ts"
import {
  createLiveFixture,
  openCodeExecutable,
  slash,
  startLiveServer,
} from "../tests/live/fixture.ts"
import { openPrivateTui } from "../tests/live/private-tui.ts"
import { scriptedProvider } from "../tests/live/scripted-provider.ts"

const SearchRoots = {
  roots: z.array(z.object({ alias: z.string(), status: z.string() })),
  partial: z.boolean(),
}
const GlobOutput = z.object({ files: z.array(z.string()), ...SearchRoots })
const GrepOutput = z.object({
  matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
  ...SearchRoots,
})

// One end-to-end check of the actual package, after implementation. Reuses the
// existing private transport/provider; there is no second workspace implementation.
const { provider, replies, requests, nativeHold } = scriptedProvider()
let fixture: Awaited<ReturnType<typeof createLiveFixture>> | undefined
let host: Awaited<ReturnType<typeof startLiveServer>> | undefined
try {
  fixture = await createLiveFixture(provider.url.origin)
  const executable = await openCodeExecutable()
  const product = path.join(fixture.base, "workspace-package")
  const build = await Bun.build({
    entrypoints: ["index.ts", "tui.ts", "rpc.ts"].map((name) =>
      path.resolve(import.meta.dir, "../src", name),
    ),
    outdir: product,
    target: "bun",
    external: [
      "@opencode/plugin",
      "@opencode/plugin/*",
      "@opentui/core",
      "@opentui/solid",
      "@opentui/solid/*",
      "solid-js",
      "solid-js/*",
    ],
  })
  if (!build.success) throw new AggregateError(build.logs, "Workspace package failed to build")
  await fs.writeFile(
    path.join(product, "package.json"),
    JSON.stringify({
      name: "opencode-workspaces-development",
      type: "module",
      exports: { ".": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" },
    }),
  )
  await fs.symlink(
    path.resolve(import.meta.dir, "../node_modules"),
    path.join(product, "node_modules"),
    "junction",
  )
  // Test harness exposure only. Original executors, schemas, permissions and IDs
  // remain native; the product does not change native Code Mode exposure.
  const overlay = path.join(product, "direct-tools.js")
  await fs.writeFile(
    overlay,
    `import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({id:"workspace-development.direct-tools",async setup(ctx){await ctx.tool.transform(editor=>{for(const name of ["read","edit","write","patch","shell","glob","grep"])editor.update(name,tool=>{tool.options={...tool.options,codemode:false}})})}})\n`,
  )
  const configFile = path.join(fixture.launch, "opencode.json")
  const config = {
    ...z.looseObject({}).parse(await Bun.file(configFile).json()),
    plugins: [
      {
        package: slash(product),
        options: { catalogPath: slash(path.join(fixture.base, "workspace-catalog.sqlite")) },
      },
      slash(overlay),
    ],
  }
  await fs.writeFile(configFile, JSON.stringify(config, null, 2))
  host = await startLiveServer(executable, fixture)
  const location = { directory: slash(fixture.launch) }
  await host.client.model.list({ location })
  const inventory = await host.client.plugin.list({ location })
  assert.equal(
    inventory.data.find((plugin) => plugin.id === "workspace-manager.v2")?.state.status,
    "active",
    JSON.stringify(inventory),
  )
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
    await ui.screen.until(
      (view) =>
        view.includes("DRAFT_WORKSPACE") &&
        !view.includes("Folder saved") &&
        !view.includes("Add current folder"),
      "draft after applying saved roots",
    )
    ui.send("_AFTER")
    await ui.until("DRAFT_WORKSPACE_AFTER")
    await ui.resize(64, 24)
    await ui.until("[ws:alpha-demo]")
    ui.snapshot("64-column workspace indicator and preserved editable draft")

    let catalog = await rpc.state({}, { location })
    const betaName = "workspace-beta-very-long-display-name-for-small-terminals"
    catalog = await rpc.change(
      {
        requestID: crypto.randomUUID(),
        expectedRevision: catalog.revision,
        action: { kind: "create", name: betaName },
      },
      { location },
    )
    const betaID = catalog.workspaces.find((workspace) => workspace.name === betaName)!.id
    const beta = await host.client.session.create({ location, title: "Indicator session B" })
    await rpc.change(
      {
        requestID: crypto.randomUUID(),
        expectedRevision: catalog.revision,
        sessionID: beta.id,
        action: { kind: "attach", workspaceID: betaID },
      },
      { location },
    )
    const otherUI = await openPrivateTui(executable, fixture, host, "workspace-second", beta.id)
    try {
      await otherUI.until("[ws:workspace-beta")
      await otherUI.resize(64, 24)
      await otherUI.screen.until(
        (view) =>
          view.includes("[ws:workspace-beta") && view.includes("…") && !view.includes(betaName),
        "ellipsized workspace name at 64 columns",
      )
      assert.ok(
        ui.screen.text().includes("[ws:alpha-demo]"),
        "Another client/session must not retarget this indicator",
      )
      otherUI.snapshot("independent second session with ellipsized long workspace name")
    } finally {
      await otherUI.close()
    }
    assert.equal(requests.length, 0)
  } finally {
    await ui.close()
  }
  const sessions = (await host.client.session.list({ directory: location.directory })).data
  assert.equal(sessions.length, 2)
  const sessionID = sessions.find((session) => session.title === "Workspace: alpha-demo")!.id
  assert.deepEqual(await host.client.session.context({ sessionID }), [])
  const selected = await rpc.state({ sessionID }, { location })
  assert.equal(selected.binding?.workspace?.roots.length, 3)
  console.log(
    "PASS actual /workspace: create, browse, add two roots, explicitly open empty session; zero provider requests",
  )
  console.log(
    "PASS actual indicator: independent sessions, narrow-terminal ellipsis, direct add/apply, and preserved editable draft",
  )
  const roots = [fixture.rootA, fixture.rootB]
  replies.push(
    roots.map((root) => ({
      name: "read",
      input: { path: slash(path.join(root, "src/answer.mjs")) },
    })),
    roots.map((root) => ({
      name: "edit",
      input: {
        path: slash(path.join(root, "src/answer.mjs")),
        oldString: "answer = 1",
        newString: "answer = 3",
      },
    })),
    roots.flatMap((root) => [
      { name: "shell", input: { command: "node --test", workdir: slash(root) } },
      { name: "shell", input: { command: "git status --short", workdir: slash(root) } },
    ]),
    [
      {
        name: "write",
        input: {
          path: slash(path.join(fixture.rootA, ".env.fixture")),
          content: "must not be created",
        },
      },
    ],
    [],
  )
  await host.client.session.prompt({
    sessionID,
    text: "Make and verify the controlled change across both workspace repositories.",
  })
  await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90_000) })
  assert.equal(replies.length, 0)
  for (const root of roots)
    assert.equal(
      await fs.readFile(path.join(root, "src/answer.mjs"), "utf8"),
      "export const answer = 3\n",
    )
  assert.equal(await fs.exists(path.join(fixture.rootA, ".env.fixture")), false)
  const transcript = await host.client.session.context({ sessionID })
  const tools = transcript.flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
  assert.equal(
    tools.filter((tool) => tool.state.status === "error").length,
    1,
    JSON.stringify(tools),
  )
  for (const tool of tools.filter((tool) => tool.name === "shell")) {
    assert.equal(tool.state.status, "completed", JSON.stringify(tool))
    if (tool.state.status === "completed")
      assert.equal(tool.state.metadata?.exit, 0, JSON.stringify(tool))
  }
  assert.match(JSON.stringify(requests[1]), /ROOT_A_RULE_MARKER_NESTED/)
  assert.match(JSON.stringify(requests[1]), /ROOT_B_RULE_MARKER_NESTED/)
  let state = await rpc.state({ sessionID }, { location })
  assert.equal(state.binding?.sealed, true)
  await assert.rejects(
    rpc.change(
      {
        requestID: crypto.randomUUID(),
        expectedRevision: state.revision,
        sessionID,
        action: { kind: "detach" },
      },
      { location },
    ),
    { type: "workspace", data: { code: "SESSION_STARTED" } },
  )
  state = await rpc.change(
    {
      requestID: crypto.randomUUID(),
      expectedRevision: state.revision,
      action: {
        kind: "removeRoot",
        workspaceID: state.workspaces[0]!.id,
        alias: state.workspaces[0]!.roots[0]!.alias,
      },
    },
    { location },
  )
  assert.equal((await rpc.state({ sessionID }, { location })).binding?.workspace?.roots.length, 3)
  console.log(
    "PASS actual plugin: scoped instructions, two native edits, both test suites/Git, sensitive-path rejection, sealed selection and pinned roots",
  )
  const betaSessionID = sessions.find((session) => session.title === "Indicator session B")!.id
  const rootA = selected.binding!.workspace!.roots.find((root) => root.path === slash(roots[0]!))!
  const rootB = selected.binding!.workspace!.roots.find((root) => root.path === slash(roots[1]!))!
  for (const root of roots)
    await fs.writeFile(path.join(root, "workspace-search.txt"), "WORKSPACE_SEARCH_VISIBLE\n")
  await fs.writeFile(
    path.join(fixture.rootA, "workspace-search-many.txt"),
    "WORKSPACE_SEARCH_VISIBLE\n".repeat(120),
  )
  await fs.appendFile(path.join(fixture.rootA, ".gitignore"), "\nworkspace-search-ignored.txt\n")
  await fs.writeFile(
    path.join(fixture.rootA, "workspace-search-ignored.txt"),
    "WORKSPACE_SEARCH_VISIBLE NEVER_PRINT_IGNORED\n",
  )
  await fs.writeFile(
    path.join(fixture.rootA, ".env.workspace-search"),
    "WORKSPACE_SEARCH_VISIBLE NEVER_PRINT_SENSITIVE\n",
  )
  replies.push(
    [
      { name: "workspace_glob", input: { pattern: "**/workspace-search*.txt" } },
      {
        name: "workspace_grep",
        input: { pattern: "WORKSPACE_SEARCH_VISIBLE", include: "**/workspace-search*.txt" },
      },
      {
        name: "workspace_grep",
        input: { pattern: "WORKSPACE_SEARCH_VISIBLE", alias: rootB.alias },
      },
      { name: "grep", input: { pattern: "WORKSPACE_SEARCH_VISIBLE", path: slash(fixture.rootA) } },
    ],
    [],
  )
  await host.client.session.prompt({
    sessionID,
    text: "Check bounded search of the pinned workspace, including the root removed from its saved definition.",
  })
  await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(90_000) })
  const searched = (await host.client.session.context({ sessionID })).flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
  const searchTools = searched.filter(
    (tool) => tool.name === "workspace_glob" || tool.name === "workspace_grep",
  )
  assert.equal(searchTools.length, 3)
  const texts = searchTools.map((tool) => {
    assert.equal(tool.state.status, "completed", JSON.stringify(tool))
    if (tool.state.status !== "completed") throw new Error("Workspace search failed")
    const text = tool.state.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    assert.doesNotMatch(text, /NEVER_PRINT_|workspace-search-ignored|\.env\.workspace-search/)
    return JSON.parse(text)
  })
  const globbed = GlobOutput.parse(texts[0])
  const grepped = GrepOutput.parse(texts[1])
  const aliased = GrepOutput.parse(texts[2])
  assert.ok(globbed.files.includes(`${rootA.alias}:/workspace-search.txt`))
  assert.ok(globbed.files.includes(`${rootB.alias}:/workspace-search.txt`))
  assert.equal(grepped.roots.find((root) => root.alias === rootA.alias)?.status, "truncated")
  assert.ok(grepped.matches.some((match) => match.file === `${rootB.alias}:/workspace-search.txt`))
  assert.equal(grepped.partial, true)
  assert.deepEqual(aliased.matches, [
    { file: `${rootB.alias}:/workspace-search.txt`, line: 1, text: "WORKSPACE_SEARCH_VISIBLE" },
  ])
  assert.ok(
    searched.some(
      (tool) =>
        tool.name === "grep" &&
        tool.state.status === "error" &&
        tool.state.error.message.includes("USE_WORKSPACE_SEARCH"),
    ),
  )
  replies.push([{ name: "workspace_glob", input: { pattern: "**/workspace-search*.txt" } }], [])
  await host.client.session.prompt({
    sessionID: betaSessionID,
    text: "Search only this session's empty workspace.",
  })
  await host.client.session.wait(
    { sessionID: betaSessionID },
    { signal: AbortSignal.timeout(30_000) },
  )
  const isolated = (await host.client.session.context({ sessionID: betaSessionID }))
    .flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    .find((tool) => tool.name === "workspace_glob")
  assert.equal(isolated?.state.status, "completed", JSON.stringify(isolated))
  if (isolated?.state.status === "completed")
    assert.deepEqual(
      GlobOutput.parse(
        JSON.parse(
          isolated.state.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ),
      ).files,
      [],
    )
  assert.equal(replies.length, 0)
  console.log(
    "PASS actual search: pinned session roots, aliases, ignore/secrets, fair truncation, native guard and independent session isolation",
  )
  const linkedRoot = path.join(fixture.base, "outside-root-alias")
  await fs.symlink(fixture.rootA, linkedRoot, process.platform === "win32" ? "junction" : "dir")
  const linkedFile = slash(path.join(linkedRoot, "src/answer.mjs"))
  const partialPatchFile = slash(path.join(fixture.rootB, "workspace-search.txt"))
  const renameSource = slash(path.join(fixture.rootA, "src/answer.mjs"))
  const pathCases = [
    {
      name: "read",
      input: { path: slash(path.join(linkedRoot, ".env.workspace-search")) },
      code: "DENIED_PATH",
    },
    { name: "read", input: { path: linkedFile }, code: "OUTSIDE_ROOT" },
    {
      name: "edit",
      input: { path: linkedFile, oldString: "answer = 3", newString: "answer = 99" },
      code: "OUTSIDE_ROOT",
    },
    {
      name: "write",
      input: {
        path: slash(path.join(linkedRoot, "new/linked-write.txt")),
        content: "must not be created",
      },
      code: "OUTSIDE_ROOT",
    },
    {
      name: "patch",
      input: {
        patchText: `*** Begin Patch\n*** Update File: ${partialPatchFile}\n@@\n-WORKSPACE_SEARCH_VISIBLE\n+PATCH_MUST_NOT_BE_APPLIED\n*** Add File: ${slash(path.join(linkedRoot, "new/linked-patch.txt"))}\n+must not be created\n*** End Patch`,
      },
      code: "OUTSIDE_ROOT",
    },
    {
      name: "patch",
      input: {
        patchText: `*** Begin Patch\n*** Update File: ${renameSource}\n*** Move to: ${slash(path.join(linkedRoot, "new/linked-move.mjs"))}\n@@\n-export const answer = 3\n+export const answer = 99\n*** End Patch`,
      },
      code: "OUTSIDE_ROOT",
    },
    {
      name: "shell",
      input: {
        command: `node -e "require('fs').writeFileSync('shell-must-not-run.txt','blocked')"`,
        workdir: slash(linkedRoot),
      },
      code: "OUTSIDE_ROOT",
    },
    {
      name: "glob",
      input: { pattern: "**/*", path: slash(linkedRoot) },
      code: "USE_WORKSPACE_SEARCH",
    },
    {
      name: "grep",
      input: { pattern: "WORKSPACE_SEARCH_VISIBLE", path: slash(linkedRoot) },
      code: "USE_WORKSPACE_SEARCH",
    },
  ]
  replies.push(
    pathCases.map(({ name, input }) => ({ name, input })),
    [],
  )
  await host.client.session.prompt({
    sessionID,
    text: "Verify native workspace preflight rejects outside linked aliases before any file, patch or shell side effects.",
  })
  await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) })
  const pathTools = (await host.client.session.context({ sessionID }))
    .flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    .slice(searched.length)
  assert.equal(pathTools.length, pathCases.length)
  for (const [index, tool] of pathTools.entries()) {
    assert.equal(tool.name, pathCases[index]!.name)
    assert.equal(tool.state.status, "error", JSON.stringify(tool))
    if (tool.state.status === "error")
      assert.ok(tool.state.error.message.includes(pathCases[index]!.code), JSON.stringify(tool))
  }
  assert.equal(await fs.readFile(renameSource, "utf8"), "export const answer = 3\n")
  assert.equal(await fs.readFile(partialPatchFile, "utf8"), "WORKSPACE_SEARCH_VISIBLE\n")
  assert.equal(await fs.exists(path.join(fixture.rootA, "new")), false)
  assert.equal(await fs.exists(path.join(fixture.rootA, "shell-must-not-run.txt")), false)
  assert.doesNotMatch(JSON.stringify(requests), /NEVER_PRINT_SENSITIVE/)
  assert.equal(replies.length, 0)
  await fs.writeFile(
    path.join(fixture.base, "working-plugin-path-checks.json"),
    JSON.stringify(pathTools, null, 2),
  )
  console.log(
    "PASS actual native paths: outside linked aliases blocked for read/edit/write/patch/rename/shell/glob/grep; no partial mutations",
  )
  const deniedSearchFile = slash(path.join(fixture.rootB, "workspace-denied.txt"))
  await fs.writeFile(deniedSearchFile, "needle DO_NOT_DELIVER_DENIED_SEARCH_CONTENT\n")
  await host.client.session.update({
    sessionID,
    permissions: [
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "read", resource: deniedSearchFile, effect: "deny" },
    ],
  })
  replies.push(
    [
      {
        name: "workspace_grep",
        input: { pattern: "needle", alias: rootB.alias, include: "workspace-denied.txt" },
      },
    ],
    [],
  )
  await host.client.session.prompt({
    sessionID,
    text: "Verify the configured native read denial is preserved by workspace search.",
  })
  await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) })
  const denied = (await host.client.session.context({ sessionID }))
    .flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    )
    .at(-1)
  assert.equal(denied?.name, "workspace_grep")
  assert.equal(denied?.state.status, "error", JSON.stringify(denied))
  if (denied?.state.status === "error")
    assert.equal(denied.state.error.type, "permission.rejected", JSON.stringify(denied))
  assert.doesNotMatch(JSON.stringify(requests), /DO_NOT_DELIVER_DENIED_SEARCH_CONTENT/)
  const ordinary = await host.client.session.create({
    location,
    title: "Ordinary session without workspace",
  })
  await fs.writeFile(path.join(fixture.launch, "ordinary-search.txt"), "ORDINARY_NATIVE_SEARCH\n")
  replies.push(
    [
      { name: "glob", input: { pattern: "ordinary-search.txt", path: location.directory } },
      { name: "grep", input: { pattern: "ORDINARY_NATIVE_SEARCH", path: location.directory } },
      { name: "workspace_glob", input: { pattern: "**/*" } },
    ],
    [],
  )
  await host.client.session.prompt({
    sessionID: ordinary.id,
    text: "Verify ordinary native search without a workspace selection.",
  })
  await host.client.session.wait(
    { sessionID: ordinary.id },
    { signal: AbortSignal.timeout(30_000) },
  )
  const ordinaryTools = (await host.client.session.context({ sessionID: ordinary.id })).flatMap(
    (message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
  assert.equal(ordinaryTools.length, 3)
  for (const tool of ordinaryTools.filter((tool) => tool.name === "glob" || tool.name === "grep")) {
    assert.equal(tool.state.status, "completed", JSON.stringify(tool))
    if (tool.state.status === "completed")
      assert.match(JSON.stringify(tool.state.content), /ordinary-search\.txt/)
  }
  const unbound = ordinaryTools.find((tool) => tool.name === "workspace_glob")
  assert.equal(unbound?.state.status, "error")
  if (unbound?.state.status === "error") assert.match(unbound.state.error.message, /NO_WORKSPACE/)
  assert.equal(replies.length, 0)
  console.log(
    "PASS actual search permissions: native read denial propagates; unbound native search is unchanged",
  )
  assert.equal((await rpc.selection({ sessionID }, { location })).workspace?.name, "alpha-demo")
  assert.equal((await rpc.selection({ sessionID: ordinary.id }, { location })).workspace, null)
  await host.client.session.switchModel({
    sessionID: betaSessionID,
    model: { providerID: "workspace-fixture", id: "fixture-small" },
  })
  const blockedUI = await openPrivateTui(
    executable,
    fixture,
    host,
    "workspace-blocked",
    betaSessionID,
  )
  try {
    await blockedUI.until("[ws:workspace-beta")
    replies.push([])
    await host.client.session.prompt({
      sessionID: betaSessionID,
      text: "Show the unsupported instruction-budget state; do not call tools.",
    })
    await host.client.session.wait(
      { sessionID: betaSessionID },
      { signal: AbortSignal.timeout(30_000) },
    )
    await blockedUI.until("!]")
    assert.equal(
      (await rpc.selection({ sessionID: betaSessionID }, { location })).instructions,
      "blocked",
    )
    assert.equal((await rpc.selection({ sessionID }, { location })).instructions, "ready")
    blockedUI.snapshot(
      "blocked instruction budget is visible without changing another session's status",
    )
  } finally {
    await blockedUI.close()
  }
  console.log("PASS actual indicator: blocked instruction budget is visible and session-scoped")
  await host.stop()
  host = await startLiveServer(executable, fixture)
  await host.client.model.list({ location })
  const restored = await host.client.rpc(WorkspaceRPC).state({ sessionID }, { location })
  assert.equal(restored.binding?.sealed, true)
  assert.equal(restored.binding?.workspace?.roots.length, 3)
  assert.equal(restored.workspaces[0]?.roots.length, 2)
  console.log("PASS actual catalog and pinned session survive private-server restart")
  await fs.writeFile(
    path.join(fixture.base, "working-plugin-results.json"),
    JSON.stringify(
      {
        passed: true,
        implementation: "src/index.ts + src/tui.ts",
        sessionID,
        adminProviderRequests: 0,
        modelRequests: requests.length,
        restored,
      },
      null,
      2,
    ),
  )
  await fs.writeFile(
    path.join(fixture.base, "working-plugin-transcript.json"),
    JSON.stringify(await host.client.session.context({ sessionID }), null, 2),
  )
} finally {
  if (fixture)
    await fs.writeFile(
      path.join(fixture.base, "provider-requests.json"),
      JSON.stringify(requests, null, 2),
    )
  nativeHold.release.resolve([])
  try {
    await host?.stop()
  } finally {
    await provider.stop(true)
  }
  if (fixture) console.log(`Retained working-plugin fixture: ${fixture.base}`)
}
