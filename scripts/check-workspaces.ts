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
  type LiveFixture,
  type LiveHost,
} from "../tests/live/fixture.ts"
import { openPrivateTui, type PrivateTui } from "../tests/live/private-tui.ts"
import { scriptedProvider, type ScriptedProvider } from "../tests/live/scripted-provider.ts"
import { ENTRYPOINTS, HOST_EXTERNALS } from "./lib/externals.ts"

// One end-to-end check of the actual package, after implementation. Reuses the
// existing private transport/provider; there is no second workspace implementation.
// Each phase below checks one area and logs one or more PASS lines.

const SearchRoots = {
  roots: z.array(z.object({ alias: z.string(), status: z.string() })),
  partial: z.boolean(),
}
const GlobOutput = z.object({ files: z.array(z.string()), ...SearchRoots })
const GrepOutput = z.object({
  matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
  ...SearchRoots,
})

// Test harness exposure only. Original executors, schemas, permissions and IDs
// remain native; the product does not change native Code Mode exposure.
const DIRECT_TOOLS_OVERLAY = `
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "workspace-development.direct-tools",
  async setup(ctx) {
    await ctx.tool.transform(editor => {
      for (const name of ["read", "edit", "write", "patch", "shell", "glob", "grep"])
        editor.update(name, tool => {
          tool.options = { ...tool.options, codemode: false }
        })
    })
  },
})
`.trimStart()

function workspaceRpc(host: LiveHost) {
  return host.client.rpc(WorkspaceRPC)
}

type WorkspaceRpc = ReturnType<typeof workspaceRpc>
type WorkspaceState = Awaited<ReturnType<WorkspaceRpc["state"]>>
type ChangeAction = Parameters<WorkspaceRpc["change"]>[0]["action"]
type Messages = Awaited<ReturnType<LiveHost["client"]["session"]["context"]>>
type ToolPart = ReturnType<typeof toolParts>[number]
type RootRef = { alias: string }

// Everything the phases share. `host` is replaced by the restart phase.
type Live = {
  fixture: LiveFixture
  executable: string
  host: LiveHost
  location: { directory: string }
  rpc: WorkspaceRpc
  replies: ScriptedProvider["replies"]
  requests: ScriptedProvider["requests"]
}

// What the menu phase leaves behind for the later phases.
type Pinned = {
  sessionID: string
  betaSessionID: string
  selected: WorkspaceState
}

function toolParts(messages: Messages) {
  return messages.flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
}

async function sessionTools(live: Live, sessionID: string) {
  return toolParts(await live.host.client.session.context({ sessionID }))
}

function completedText(tool: ToolPart) {
  assert.equal(tool.state.status, "completed", JSON.stringify(tool))
  if (tool.state.status !== "completed") throw new Error("Workspace search failed")
  return tool.state.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function promptAndWait(live: Live, sessionID: string, text: string, timeoutMs: number) {
  await live.host.client.session.prompt({ sessionID, text })
  await live.host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(timeoutMs) })
}

function changeRequest(state: WorkspaceState, action: ChangeAction, sessionID?: string) {
  return {
    requestID: crypto.randomUUID(),
    expectedRevision: state.revision,
    ...(sessionID === undefined ? {} : { sessionID }),
    action,
  }
}

function fixtureRoots(live: Live) {
  return [live.fixture.rootA, live.fixture.rootB]
}

function pinnedRoots(live: Live, pinned: Pinned) {
  const [pathA, pathB] = fixtureRoots(live).map(slash)
  const roots = pinned.selected.binding!.workspace!.roots
  return {
    rootA: roots.find((root) => root.path === pathA)!,
    rootB: roots.find((root) => root.path === pathB)!,
  }
}

function answerFile(root: string) {
  return slash(path.join(root, "src/answer.mjs"))
}

// Files that the path-preflight phase must leave unmodified.
function guardedFiles(fixture: LiveFixture) {
  return {
    renameSource: answerFile(fixture.rootA),
    partialPatchFile: slash(path.join(fixture.rootB, "workspace-search.txt")),
  }
}

async function buildProduct(product: string) {
  const build = await Bun.build({
    entrypoints: ENTRYPOINTS.map((name) => path.resolve(import.meta.dir, "../src", name)),
    outdir: product,
    target: "bun",
    external: HOST_EXTERNALS,
  })
  if (!build.success) throw new AggregateError(build.logs, "Workspace package failed to build")
}

async function writeProductManifest(product: string) {
  const manifest = {
    name: "opencode-workspaces-development",
    type: "module",
    exports: { ".": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" },
  }
  await fs.writeFile(path.join(product, "package.json"), JSON.stringify(manifest))
  await fs.symlink(
    path.resolve(import.meta.dir, "../node_modules"),
    path.join(product, "node_modules"),
    "junction",
  )
}

async function registerProduct(fixture: LiveFixture, product: string) {
  const overlay = path.join(product, "direct-tools.js")
  await fs.writeFile(overlay, DIRECT_TOOLS_OVERLAY)
  const configFile = path.join(fixture.launch, "opencode.json")
  const catalogPath = slash(path.join(fixture.base, "workspace-catalog.sqlite"))
  const config = {
    ...z.looseObject({}).parse(await Bun.file(configFile).json()),
    plugins: [{ package: slash(product), options: { catalogPath } }, slash(overlay)],
  }
  await fs.writeFile(configFile, JSON.stringify(config, null, 2))
}

async function setUpPackage(fixture: LiveFixture, scripted: ScriptedProvider): Promise<Live> {
  const executable = await openCodeExecutable()
  const product = path.join(fixture.base, "workspace-package")
  await buildProduct(product)
  await writeProductManifest(product)
  await registerProduct(fixture, product)
  const host = await startLiveServer(executable, fixture)
  return {
    fixture,
    executable,
    host,
    location: { directory: slash(fixture.launch) },
    rpc: workspaceRpc(host),
    replies: scripted.replies,
    requests: scripted.requests,
  }
}

async function checkPluginActive(live: Live) {
  const { host, location, rpc } = live
  await host.client.model.list({ location })
  const inventory = await host.client.plugin.list({ location })
  assert.equal(
    inventory.data.find((plugin) => plugin.id === "workspace-manager.v2")?.state.status,
    "active",
    JSON.stringify(inventory),
  )
  assert.equal((await rpc.state({}, { location })).workspaces.length, 0)
}

async function addFolder(ui: PrivateTui, root: string, finished = "Switch / open workspace") {
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

async function createWorkspace(ui: PrivateTui) {
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
}

async function addTwoFolders(live: Live, ui: PrivateTui) {
  const { fixture, host, location, rpc, requests } = live
  ui.send("\r") // Add folder after creation.
  await addFolder(ui, fixture.rootA)
  ui.send("Add folder to saved workspace\r")
  await ui.until("Saved workspaces")
  ui.send("\r")
  await addFolder(ui, fixture.rootB)
  ui.snapshot("real saved workspace with two folders")
  const state = await rpc.state({}, { location })
  assert.equal(state.workspaces[0]?.roots.length, 2)
  assert.equal(requests.length, 0)
  assert.equal((await host.client.session.list({ directory: location.directory })).data.length, 0)
}

async function openEmptySession(ui: PrivateTui) {
  ui.send("Switch / open workspace\r")
  await ui.until("Saved workspaces")
  ui.send("\r")
  await ui.until("Open in new session")
  ui.send("\r")
  await ui.until("Workspace: alpha-demo")
  await ui.until("[ws:alpha-demo]")
  ui.snapshot("explicitly opened empty workspace session")
}

async function addFolderToDraft(live: Live, ui: PrivateTui) {
  ui.send("DRAFT_WORKSPACE")
  await ui.until("DRAFT_WORKSPACE")
  ui.send("\x10")
  await ui.until("Commands")
  ui.send("Add workspace folder\r")
  // The direct command must target the current saved definition without
  // requiring a second workspace picker, then explicitly apply its new roots.
  await addFolder(ui, live.fixture.plain, "Folder saved")
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
}

async function checkSecondSessionIndicator(live: Live, ui: PrivateTui) {
  const { executable, fixture, host, location, rpc, requests } = live
  const betaName = "workspace-beta-very-long-display-name-for-small-terminals"
  const initial = await rpc.state({}, { location })
  const catalog = await rpc.change(changeRequest(initial, { kind: "create", name: betaName }), {
    location,
  })
  const betaID = catalog.workspaces.find((workspace) => workspace.name === betaName)!.id
  const beta = await host.client.session.create({ location, title: "Indicator session B" })
  const attach: ChangeAction = { kind: "attach", workspaceID: betaID }
  await rpc.change(changeRequest(catalog, attach, beta.id), { location })
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
}

async function checkMenuFlow(live: Live): Promise<Pinned> {
  const { executable, fixture, host, location, rpc } = live
  const ui = await openPrivateTui(executable, fixture, host, "workspace-product")
  try {
    await createWorkspace(ui)
    await addTwoFolders(live, ui)
    await openEmptySession(ui)
    await addFolderToDraft(live, ui)
    await checkSecondSessionIndicator(live, ui)
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
  const betaSessionID = sessions.find((session) => session.title === "Indicator session B")!.id
  return { sessionID, betaSessionID, selected }
}

function nativeToolReplies(live: Live) {
  const roots = fixtureRoots(live)
  const protectedFile = slash(path.join(live.fixture.rootA, ".env.fixture"))
  return [
    roots.map((root) => ({ name: "read", input: { path: answerFile(root) } })),
    roots.map((root) => ({
      name: "edit",
      input: { path: answerFile(root), oldString: "answer = 1", newString: "answer = 3" },
    })),
    roots.flatMap((root) => [
      { name: "shell", input: { command: "node --test", workdir: slash(root) } },
      { name: "shell", input: { command: "git status --short", workdir: slash(root) } },
    ]),
    [{ name: "write", input: { path: protectedFile, content: "must not be created" } }],
    [],
  ]
}

async function checkNativeToolResults(live: Live, sessionID: string) {
  const { fixture, requests } = live
  for (const root of fixtureRoots(live)) {
    const answer = await fs.readFile(path.join(root, "src/answer.mjs"), "utf8")
    assert.equal(answer, "export const answer = 3\n")
  }
  assert.equal(await fs.exists(path.join(fixture.rootA, ".env.fixture")), false)
  const tools = await sessionTools(live, sessionID)
  const failed = tools.filter((tool) => tool.state.status === "error")
  assert.equal(failed.length, 1, JSON.stringify(tools))
  for (const tool of tools.filter((tool) => tool.name === "shell")) {
    assert.equal(tool.state.status, "completed", JSON.stringify(tool))
    if (tool.state.status === "completed")
      assert.equal(tool.state.metadata?.exit, 0, JSON.stringify(tool))
  }
  assert.match(JSON.stringify(requests[1]), /ROOT_A_RULE_MARKER_NESTED/)
  assert.match(JSON.stringify(requests[1]), /ROOT_B_RULE_MARKER_NESTED/)
}

async function checkSealedSelection(live: Live, sessionID: string) {
  const { location, rpc } = live
  const state = await rpc.state({ sessionID }, { location })
  assert.equal(state.binding?.sealed, true)
  await assert.rejects(
    rpc.change(changeRequest(state, { kind: "detach" }, sessionID), { location }),
    { type: "workspace", data: { code: "SESSION_STARTED" } },
  )
  const workspace = state.workspaces[0]!
  const removeRoot: ChangeAction = {
    kind: "removeRoot",
    workspaceID: workspace.id,
    alias: workspace.roots[0]!.alias,
  }
  await rpc.change(changeRequest(state, removeRoot), { location })
  const pinned = await rpc.state({ sessionID }, { location })
  assert.equal(pinned.binding?.workspace?.roots.length, 3)
}

async function checkNativeTools(live: Live, pinned: Pinned) {
  const { sessionID } = pinned
  live.replies.push(...nativeToolReplies(live))
  await promptAndWait(
    live,
    sessionID,
    "Make and verify the controlled change across both workspace repositories.",
    90_000,
  )
  assert.equal(live.replies.length, 0)
  await checkNativeToolResults(live, sessionID)
  await checkSealedSelection(live, sessionID)
  console.log(
    "PASS actual plugin: scoped instructions, two native edits, both test suites/Git, sensitive-path rejection, sealed selection and pinned roots",
  )
}

async function writeSearchFixtures(live: Live) {
  const { rootA } = live.fixture
  for (const root of fixtureRoots(live))
    await fs.writeFile(path.join(root, "workspace-search.txt"), "WORKSPACE_SEARCH_VISIBLE\n")
  await fs.writeFile(
    path.join(rootA, "workspace-search-many.txt"),
    "WORKSPACE_SEARCH_VISIBLE\n".repeat(120),
  )
  await fs.appendFile(path.join(rootA, ".gitignore"), "\nworkspace-search-ignored.txt\n")
  await fs.writeFile(
    path.join(rootA, "workspace-search-ignored.txt"),
    "WORKSPACE_SEARCH_VISIBLE NEVER_PRINT_IGNORED\n",
  )
  await fs.writeFile(
    path.join(rootA, ".env.workspace-search"),
    "WORKSPACE_SEARCH_VISIBLE NEVER_PRINT_SENSITIVE\n",
  )
}

function searchReplies(live: Live, aliasB: string) {
  return [
    { name: "workspace_glob", input: { pattern: "**/workspace-search*.txt" } },
    {
      name: "workspace_grep",
      input: { pattern: "WORKSPACE_SEARCH_VISIBLE", include: "**/workspace-search*.txt" },
    },
    { name: "workspace_grep", input: { pattern: "WORKSPACE_SEARCH_VISIBLE", alias: aliasB } },
    {
      name: "grep",
      input: { pattern: "WORKSPACE_SEARCH_VISIBLE", path: slash(live.fixture.rootA) },
    },
  ]
}

function checkSearchOutputs(searched: ToolPart[], rootA: RootRef, rootB: RootRef) {
  const searchTools = searched.filter(
    (tool) => tool.name === "workspace_glob" || tool.name === "workspace_grep",
  )
  assert.equal(searchTools.length, 3)
  const texts = searchTools.map((tool) => {
    const text = completedText(tool)
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
}

async function checkIsolatedSearch(live: Live, betaSessionID: string) {
  live.replies.push(
    [{ name: "workspace_glob", input: { pattern: "**/workspace-search*.txt" } }],
    [],
  )
  await promptAndWait(live, betaSessionID, "Search only this session's empty workspace.", 30_000)
  const betaTools = await sessionTools(live, betaSessionID)
  const isolated = betaTools.find((tool) => tool.name === "workspace_glob")
  assert.equal(isolated?.state.status, "completed", JSON.stringify(isolated))
  if (isolated?.state.status === "completed")
    assert.deepEqual(GlobOutput.parse(JSON.parse(completedText(isolated))).files, [])
  assert.equal(live.replies.length, 0)
}

// Returns how many tool calls the pinned session has made so far.
async function checkSearch(live: Live, pinned: Pinned) {
  const { sessionID, betaSessionID } = pinned
  const { rootA, rootB } = pinnedRoots(live, pinned)
  await writeSearchFixtures(live)
  live.replies.push(searchReplies(live, rootB.alias), [])
  await promptAndWait(
    live,
    sessionID,
    "Check bounded search of the pinned workspace, including the root removed from its saved definition.",
    90_000,
  )
  const searched = await sessionTools(live, sessionID)
  checkSearchOutputs(searched, rootA, rootB)
  await checkIsolatedSearch(live, betaSessionID)
  console.log(
    "PASS actual search: pinned session roots, aliases, ignore/secrets, fair truncation, native guard and independent session isolation",
  )
  return searched.length
}

type PathCase = { name: string; input: Record<string, unknown>; code: string }

function patchText(...lines: string[]) {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
}

function pathCases(fixture: LiveFixture, linkedRoot: string): PathCase[] {
  const { renameSource, partialPatchFile } = guardedFiles(fixture)
  const linkedFile = answerFile(linkedRoot)
  const linkedAdd = slash(path.join(linkedRoot, "new/linked-patch.txt"))
  const linkedMove = slash(path.join(linkedRoot, "new/linked-move.mjs"))
  const partialPatch = patchText(
    `*** Update File: ${partialPatchFile}`,
    "@@",
    "-WORKSPACE_SEARCH_VISIBLE",
    "+PATCH_MUST_NOT_BE_APPLIED",
    `*** Add File: ${linkedAdd}`,
    "+must not be created",
  )
  const renamePatch = patchText(
    `*** Update File: ${renameSource}`,
    `*** Move to: ${linkedMove}`,
    "@@",
    "-export const answer = 3",
    "+export const answer = 99",
  )
  return [
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
    { name: "patch", input: { patchText: partialPatch }, code: "OUTSIDE_ROOT" },
    { name: "patch", input: { patchText: renamePatch }, code: "OUTSIDE_ROOT" },
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
}

async function checkNoPartialMutations(live: Live) {
  const { fixture, requests } = live
  const { renameSource, partialPatchFile } = guardedFiles(fixture)
  assert.equal(await fs.readFile(renameSource, "utf8"), "export const answer = 3\n")
  assert.equal(await fs.readFile(partialPatchFile, "utf8"), "WORKSPACE_SEARCH_VISIBLE\n")
  assert.equal(await fs.exists(path.join(fixture.rootA, "new")), false)
  assert.equal(await fs.exists(path.join(fixture.rootA, "shell-must-not-run.txt")), false)
  assert.doesNotMatch(JSON.stringify(requests), /NEVER_PRINT_SENSITIVE/)
  assert.equal(live.replies.length, 0)
}

async function checkPathPreflight(live: Live, pinned: Pinned, toolsBefore: number) {
  const { fixture } = live
  const linkedRoot = path.join(fixture.base, "outside-root-alias")
  await fs.symlink(fixture.rootA, linkedRoot, process.platform === "win32" ? "junction" : "dir")
  const cases = pathCases(fixture, linkedRoot)
  live.replies.push(
    cases.map(({ name, input }) => ({ name, input })),
    [],
  )
  await promptAndWait(
    live,
    pinned.sessionID,
    "Verify native workspace preflight rejects outside linked aliases before any file, patch or shell side effects.",
    60_000,
  )
  const pathTools = (await sessionTools(live, pinned.sessionID)).slice(toolsBefore)
  assert.equal(pathTools.length, cases.length)
  for (const [index, tool] of pathTools.entries()) {
    assert.equal(tool.name, cases[index]!.name)
    assert.equal(tool.state.status, "error", JSON.stringify(tool))
    if (tool.state.status === "error")
      assert.ok(tool.state.error.message.includes(cases[index]!.code), JSON.stringify(tool))
  }
  await checkNoPartialMutations(live)
  await fs.writeFile(
    path.join(fixture.base, "working-plugin-path-checks.json"),
    JSON.stringify(pathTools, null, 2),
  )
  console.log(
    "PASS actual native paths: outside linked aliases blocked for read/edit/write/patch/rename/shell/glob/grep; no partial mutations",
  )
}

async function checkReadDenialPropagates(live: Live, pinned: Pinned) {
  const { fixture, host, requests } = live
  const { sessionID } = pinned
  const { rootB } = pinnedRoots(live, pinned)
  const deniedSearchFile = slash(path.join(fixture.rootB, "workspace-denied.txt"))
  await fs.writeFile(deniedSearchFile, "needle DO_NOT_DELIVER_DENIED_SEARCH_CONTENT\n")
  await host.client.session.update({
    sessionID,
    permissions: [
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "read", resource: deniedSearchFile, effect: "deny" },
    ],
  })
  live.replies.push(
    [
      {
        name: "workspace_grep",
        input: { pattern: "needle", alias: rootB.alias, include: "workspace-denied.txt" },
      },
    ],
    [],
  )
  await promptAndWait(
    live,
    sessionID,
    "Verify the configured native read denial is preserved by workspace search.",
    30_000,
  )
  const denied = (await sessionTools(live, sessionID)).at(-1)
  assert.equal(denied?.name, "workspace_grep")
  assert.equal(denied?.state.status, "error", JSON.stringify(denied))
  if (denied?.state.status === "error")
    assert.equal(denied.state.error.type, "permission.rejected", JSON.stringify(denied))
  assert.doesNotMatch(JSON.stringify(requests), /DO_NOT_DELIVER_DENIED_SEARCH_CONTENT/)
}

// Returns the ordinary session's ID.
async function checkUnboundNativeSearch(live: Live) {
  const { fixture, host, location } = live
  const ordinary = await host.client.session.create({
    location,
    title: "Ordinary session without workspace",
  })
  await fs.writeFile(path.join(fixture.launch, "ordinary-search.txt"), "ORDINARY_NATIVE_SEARCH\n")
  live.replies.push(
    [
      { name: "glob", input: { pattern: "ordinary-search.txt", path: location.directory } },
      { name: "grep", input: { pattern: "ORDINARY_NATIVE_SEARCH", path: location.directory } },
      { name: "workspace_glob", input: { pattern: "**/*" } },
    ],
    [],
  )
  await promptAndWait(
    live,
    ordinary.id,
    "Verify ordinary native search without a workspace selection.",
    30_000,
  )
  const ordinaryTools = await sessionTools(live, ordinary.id)
  assert.equal(ordinaryTools.length, 3)
  for (const tool of ordinaryTools.filter((tool) => tool.name === "glob" || tool.name === "grep")) {
    assert.equal(tool.state.status, "completed", JSON.stringify(tool))
    if (tool.state.status === "completed")
      assert.match(JSON.stringify(tool.state.content), /ordinary-search\.txt/)
  }
  const unbound = ordinaryTools.find((tool) => tool.name === "workspace_glob")
  assert.equal(unbound?.state.status, "error")
  if (unbound?.state.status === "error") assert.match(unbound.state.error.message, /NO_WORKSPACE/)
  assert.equal(live.replies.length, 0)
  return ordinary.id
}

async function checkBlockedInstructionBudget(live: Live, pinned: Pinned) {
  const { executable, fixture, host, location, rpc } = live
  const { sessionID, betaSessionID } = pinned
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
    live.replies.push([])
    await promptAndWait(
      live,
      betaSessionID,
      "Show the unsupported instruction-budget state; do not call tools.",
      30_000,
    )
    await blockedUI.until("!]")
    const blocked = await rpc.selection({ sessionID: betaSessionID }, { location })
    assert.equal(blocked.instructions, "blocked")
    assert.equal((await rpc.selection({ sessionID }, { location })).instructions, "ready")
    blockedUI.snapshot(
      "blocked instruction budget is visible without changing another session's status",
    )
  } finally {
    await blockedUI.close()
  }
}

async function checkPermissions(live: Live, pinned: Pinned) {
  const { location, rpc } = live
  await checkReadDenialPropagates(live, pinned)
  const ordinaryID = await checkUnboundNativeSearch(live)
  console.log(
    "PASS actual search permissions: native read denial propagates; unbound native search is unchanged",
  )
  const selection = await rpc.selection({ sessionID: pinned.sessionID }, { location })
  assert.equal(selection.workspace?.name, "alpha-demo")
  assert.equal((await rpc.selection({ sessionID: ordinaryID }, { location })).workspace, null)
  await checkBlockedInstructionBudget(live, pinned)
  console.log("PASS actual indicator: blocked instruction budget is visible and session-scoped")
}

async function checkRestart(live: Live, pinned: Pinned) {
  const { executable, fixture, location, requests } = live
  const { sessionID } = pinned
  await live.host.stop()
  live.host = await startLiveServer(executable, fixture)
  await live.host.client.model.list({ location })
  const restored = await workspaceRpc(live.host).state({ sessionID }, { location })
  assert.equal(restored.binding?.sealed, true)
  assert.equal(restored.binding?.workspace?.roots.length, 3)
  assert.equal(restored.workspaces[0]?.roots.length, 2)
  console.log("PASS actual catalog and pinned session survive private-server restart")
  const results = {
    passed: true,
    implementation: "src/index.ts + src/tui.ts",
    sessionID,
    adminProviderRequests: 0,
    modelRequests: requests.length,
    restored,
  }
  await fs.writeFile(
    path.join(fixture.base, "working-plugin-results.json"),
    JSON.stringify(results, null, 2),
  )
  const transcript = await live.host.client.session.context({ sessionID })
  await fs.writeFile(
    path.join(fixture.base, "working-plugin-transcript.json"),
    JSON.stringify(transcript, null, 2),
  )
}

const scripted = scriptedProvider()
let fixture: LiveFixture | undefined
let live: Live | undefined
try {
  fixture = await createLiveFixture(scripted.provider.url.origin)
  live = await setUpPackage(fixture, scripted)
  await checkPluginActive(live)
  const pinned = await checkMenuFlow(live)
  await checkNativeTools(live, pinned)
  const toolsBefore = await checkSearch(live, pinned)
  await checkPathPreflight(live, pinned, toolsBefore)
  await checkPermissions(live, pinned)
  await checkRestart(live, pinned)
} finally {
  if (fixture)
    await fs.writeFile(
      path.join(fixture.base, "provider-requests.json"),
      JSON.stringify(scripted.requests, null, 2),
    )
  scripted.nativeHold.release.resolve([])
  try {
    await live?.host.stop()
  } finally {
    await scripted.provider.stop(true)
  }
  if (fixture) console.log(`Retained working-plugin fixture: ${fixture.base}`)
}
