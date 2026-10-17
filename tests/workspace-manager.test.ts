import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Info as NativeTool, ToolContext } from "@opencode/plugin/promise/tool"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { SessionCompaction } from "@opencode/plugin/promise/session"
import { rgPath } from "@vscode/ripgrep"
import * as fs from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import WorkspaceManager from "../.opencode/plugins/workspace-manager.ts"

type BeforeEvent = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id"> & { tool: string; input: unknown }
type Hook<Event> = (event: Event) => Promise<void> | void
type Root = { alias: string; path: string }
type Registry = {
  $schema: string
  version: 1
  active: string | null
  workspaces: Record<string, { name: string; createdAt: string; roots: Root[] }>
}
type Status = { active: string | null; roots: Root[]; fileCount: number }
type Added = { added: boolean; root: Root; roots: Root[]; workspace: string; active: string | null }
type ReadResult = { content: string; truncated: boolean }
type GlobResult = { files: string[]; truncated: boolean }
type GrepResult = { matches: { file: string; line: number; text: string }[]; truncated: boolean; engine: string }
type BrowseResult = { current: string; parent: string | null; directories: { name: string; path: string }[]; truncated: boolean }
type ToolError = { error: { code: string; message: string } }
type Permission = Parameters<Plugin.Context["permission"]["assert"]>[0]

const unix = (value: string) => value.replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase())
const oldPath = process.env.PATH

async function fixture() {
  const temporary = path.join(tmpdir(), "opencode")
  await fs.mkdir(temporary, { recursive: true })
  const originalBase = await fs.mkdtemp(path.join(temporary, "workspace-manager-test-"))
  const base = await fs.realpath(originalBase)
  const directory = path.join(base, "project")
  const docs = path.join(base, "external docs")
  const src = path.join(base, "external-src")
  const outside = path.join(base, "outside")
  const registryPath = path.join(base, "global", "workspaces.json")
  await Promise.all([directory, docs, src, outside].map((dir) => fs.mkdir(dir)))
  const toasts: { message: string; variant: string }[] = []
  const permissions: Permission[] = []
  const progress: Record<string, unknown>[] = []
  let uiFails = false
  let permissionFailure: Error | undefined
  let sessionLocation = directory
  let subpath: string | undefined
  const controller = new AbortController()
  const context: ToolContext = {
    sessionID: "ses_test" as ToolContext["sessionID"],
    messageID: "msg_test" as ToolContext["messageID"],
    agent: "build" as ToolContext["agent"],
    id: "call_test" as ToolContext["id"],
    signal: controller.signal,
    progress: async (update) => { progress.push(update) },
  }
  async function start(options: Record<string, unknown> = {}) {
    const tools: Record<string, NativeTool> = {}
    const toolHooks: Record<string, Hook<BeforeEvent>> = {}
    const sessionHooks: Record<string, Hook<SessionCompaction>> = {}
    const permissionHooks: Record<string, Hook<PermissionEvaluation>> = {}
    const registration = () => ({ dispose: async () => {} })
    // Unexpected legacy SDK methods, session.move, or permission.reply are absent.
    const input = {
      location: { directory },
      options: { registryPath, ripgrep: false, ...options },
      tool: {
        list: async () => Object.entries(tools).map(([id, tool]) => ({ ...tool, id })),
        transform: async (transform: (editor: { add(tool: NativeTool): void }) => void) => {
          transform({ add: (tool) => { tools[tool.name] = tool } })
          return registration()
        },
        hook: async (name: string, hook: Hook<BeforeEvent>) => { toolHooks[name] = hook; return registration() },
      },
      session: {
        get: async () => ({ location: { directory: sessionLocation }, ...(subpath === undefined ? {} : { subpath }) }),
        hook: async (name: string, hook: Hook<SessionCompaction>) => { sessionHooks[name] = hook; return registration() },
      },
      permission: {
        assert: async (request: Permission) => {
          permissions.push(request)
          if (permissionFailure) throw permissionFailure
        },
        hook: async (name: string, hook: Hook<PermissionEvaluation>) => { permissionHooks[name] = hook; return registration() },
      },
      rpc: {
        register: async () => ({
          ...registration(),
          events: { emit: async (_name: string, input: { message: string; variant: string }) => {
            if (uiFails) throw new Error("No UI transport")
            toasts.push(input)
          } },
        }),
      },
    } as unknown as Plugin.Context
    await WorkspaceManager.setup(input)
    return { tools, toolHooks, sessionHooks, permissionHooks }
  }
  let runtime: Awaited<ReturnType<typeof start>>
  async function load(options: Record<string, unknown> = {}) { runtime = await start(options); return runtime }
  await load()
  async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const definition = runtime.tools[name]
    if (!definition) throw new Error(`Unknown tool ${name}`)
    const result = await definition.execute(args, context)
    if (typeof result.content !== "string") throw new Error("Expected a native V2 text result")
    return JSON.parse(result.content) as T
  }
  async function inject(kind: "context" | "compaction" = "context", summary?: string) {
    const event = {
      sessionID: context.sessionID, agent: context.agent, model: {}, tools: {}, messages: [], options: [], system: [],
      ...(summary === undefined ? {} : { result: { summary, metadata: { preserve: true } } }),
    } as unknown as SessionCompaction
    await runtime.sessionHooks[kind]!(event)
    return event
  }
  async function evaluate(input: Omit<PermissionEvaluation, "sessionID">) {
    const event: PermissionEvaluation = { sessionID: context.sessionID, ...input }
    await runtime.permissionHooks["evaluate"]!(event)
    return event
  }
  async function before(tool: string, args: Record<string, unknown>) {
    await runtime.toolHooks["execute.before"]!({ ...context, tool, input: args })
  }
  async function createAndAdd() {
    expect(await call("workspace_create", { name: "research-xyz" })).not.toHaveProperty("error")
    expect(await call("workspace_add", { workspace: "research-xyz", path: docs, alias: "docs" })).not.toHaveProperty("error")
    expect(await call("workspace_add", { workspace: "research-xyz", path: src, alias: "src" })).not.toHaveProperty("error")
  }
  return {
    base, originalBase, directory, docs, src, outside, registryPath, context, controller,
    toasts, permissions, progress, start, load, call, inject, evaluate, before, createAndAdd,
    get runtime() { return runtime },
    failUI() { uiFails = true },
    denyPermission(error: Error) { permissionFailure = error },
    setSessionDirectory(value: string) { sessionLocation = value },
    setSubpath(value: string) { subpath = value },
    async write(root: string, file: string, content: string | Buffer) {
      const absolute = path.join(root, file)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, content)
      return absolute
    },
    async dispose() {
      // Only this fixture's freshly created, uniquely named directory is removed.
      await fs.rm(base, { recursive: true, force: true })
    },
  }
}

let h: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => { h = await fixture() })
afterEach(async () => {
  if (oldPath === undefined) delete process.env.PATH
  else process.env.PATH = oldPath
  await h.dispose()
})

describe("registry and exact tool contract", () => {
  test("registers the nine requested tools plus the folder-only picker helper", () => {
    const expected: Record<string, string[]> = {
      workspace_create: ["name"],
      workspace_switch: ["name"],
      workspace_list: [],
      workspace_add: ["workspace", "path", "alias"],
      workspace_remove: ["workspace", "aliasOrPath"],
      workspace_read: ["path"],
      workspace_glob: ["pattern", "alias"],
      workspace_grep: ["pattern", "alias", "include"],
      workspace_status: [],
      workspace_browse: ["path"],
    }
    expect(WorkspaceManager.id).toBe("workspace-manager")
    expect(typeof WorkspaceManager.setup).toBe("function")
    expect(Object.keys(h.runtime.tools)).toEqual(Object.keys(expected))
    for (const [name, args] of Object.entries(expected)) {
      const definition = h.runtime.tools[name]!
      const schema = definition.input as { properties: Record<string, unknown>; additionalProperties: boolean }
      expect(Object.keys(schema.properties)).toEqual(args)
      expect(schema.additionalProperties).toBe(false)
      expect(definition.options?.codemode).toBe(false)
    }
    expect(Object.keys(h.runtime.toolHooks)).toEqual(["execute.before"])
    expect(Object.keys(h.runtime.sessionHooks)).toEqual(["context", "compaction"])
    expect(Object.keys(h.runtime.permissionHooks)).toEqual(["evaluate"])
  })

  test("starts empty without creating or modifying the user's global registry", async () => {
    expect(await h.call("workspace_list")).toMatchObject({ version: 1, active: null, workspaces: {} })
    expect(await h.call("workspace_status")).toEqual({ active: null, roots: [], fileCount: 0 })
    expect(await fs.exists(h.registryPath)).toBe(false)
  })

  test("create -> add two non-git external folders (one with spaces) -> switch -> restart persists", async () => {
    const cwd = process.cwd()
    await h.write(h.docs, "spec.md", "Deprecated API\n")
    await h.write(h.src, "api.ts", "export const answer = 42\n")
    await h.createAndAdd()
    await h.call("workspace_create", { name: "empty" })
    expect(await h.call("workspace_status")).toEqual({ active: "empty", roots: [], fileCount: 0 })
    await h.call("workspace_switch", { name: "research-xyz" })
    const before = await h.call<Registry>("workspace_list")
    expect(before.workspaces["research-xyz"]!.roots).toEqual([
      { alias: "docs", path: unix(await fs.realpath(h.docs)) },
      { alias: "src", path: unix(await fs.realpath(h.src)) },
    ])
    expect(before.$schema).toBe("https://example.com/workspace-manager.json")
    expect(Number.isNaN(Date.parse(before.workspaces["research-xyz"]!.createdAt))).toBe(false)
    await h.load()
    expect(await h.call("workspace_list")).toEqual(before)
    expect(await h.call("workspace_status")).toMatchObject({ active: "research-xyz", fileCount: 2 })
    expect(await h.call("workspace_read", { path: "src:/api.ts" })).toEqual({ content: "export const answer = 42\n", truncated: false })
    expect(process.cwd()).toBe(cwd)
    expect(await fs.exists(path.join(h.docs, ".git"))).toBe(false)
    expect((await fs.readdir(path.dirname(h.registryPath))).sort()).toEqual(["workspaces.json"])
  })

  test("deduplicates canonical paths and aliases, and generates collision-free aliases", async () => {
    await h.createAndAdd()
    const duplicate = await h.call<Added>("workspace_add", { workspace: "research-xyz", path: `${h.docs}${path.sep}.`, alias: "other" })
    expect(duplicate.added).toBe(false)
    expect(duplicate.root.alias).toBe("docs")
    expect(duplicate.roots).toHaveLength(2)
    expect((await h.call<ToolError>("workspace_add", { workspace: "research-xyz", path: h.outside, alias: "docs" })).error.code).toBe("ALIAS_EXISTS")
    const first = await h.write(h.outside, "one/src/file", "one")
    const second = await h.write(h.outside, "two/src/file", "two")
    const added = await h.call<Added>("workspace_add", { workspace: "research-xyz", path: path.dirname(first) })
    const added2 = await h.call<Added>("workspace_add", { workspace: "research-xyz", path: path.dirname(second) })
    expect(added.root.alias).toBe("src-2")
    expect(added2.root.alias).toBe("src-3")
  })

  test("root limit is 20; an existing root is still a no-op at the limit", async () => {
    await h.call("workspace_create", { name: "many" })
    for (let index = 0; index < 20; index++) {
      const directory = path.join(h.outside, String(index))
      await fs.mkdir(directory)
      expect(await h.call("workspace_add", { workspace: "many", path: directory })).not.toHaveProperty("error")
    }
    expect((await h.call<Added>("workspace_add", { workspace: "many", path: path.join(h.outside, "0") })).added).toBe(false)
    expect((await h.call<ToolError>("workspace_add", { workspace: "many", path: h.docs })).error.code).toBe("ROOT_LIMIT")
  })

  test("missing directories, files-as-roots and unknown workspaces return clean errors", async () => {
    await h.call("workspace_create", { name: "test" })
    const file = await h.write(h.docs, "not-a-dir.txt", "text")
    expect((await h.call<ToolError>("workspace_add", { workspace: "test", path: path.join(h.docs, "missing") })).error.code).toBe("ENOENT")
    expect((await h.call<ToolError>("workspace_add", { workspace: "test", path: file })).error.code).toBe("NOT_DIRECTORY")
    expect((await h.call<ToolError>("workspace_switch", { name: "missing" })).error.code).toBe("UNKNOWN_WORKSPACE")
    expect((await h.call<ToolError>("workspace_create", { name: "test" })).error.code).toBe("WORKSPACE_EXISTS")
  })

  test("removes roots or whole workspaces without touching files", async () => {
    await h.write(h.docs, "keep.txt", "keep me")
    await h.createAndAdd()
    await h.call("workspace_remove", { workspace: "research-xyz", aliasOrPath: "docs" })
    expect(await h.call("workspace_status")).toMatchObject({ roots: [{ alias: "src" }] })
    await h.call("workspace_remove", { workspace: "research-xyz", aliasOrPath: h.src })
    expect(await h.call("workspace_status")).toMatchObject({ roots: [] })
    await h.call("workspace_remove", { workspace: "research-xyz" })
    expect(await h.call("workspace_list")).toMatchObject({ active: null, workspaces: {} })
    expect(await fs.readFile(path.join(h.docs, "keep.txt"), "utf8")).toBe("keep me")
  })

  test("a full project override replaces, not merges, the global registry", async () => {
    await h.createAndAdd()
    const globalBefore = await fs.readFile(h.registryPath, "utf8")
    const override = path.join(h.directory, ".opencode", "workspace.json")
    await fs.mkdir(path.dirname(override))
    await fs.writeFile(override, JSON.stringify({ version: 1, active: null, workspaces: {} }))
    await h.load({ registryPath: undefined })
    expect(await h.call("workspace_list")).toMatchObject({ active: null, workspaces: {} })
    await h.call("workspace_create", { name: "project-only" })
    expect(JSON.parse(await fs.readFile(override, "utf8")).active).toBe("project-only")
    expect(await fs.readFile(h.registryPath, "utf8")).toBe(globalBefore)
  })

  test("corrupt and invalid registries fail closed without being overwritten", async () => {
    await h.call("workspace_create", { name: "first" })
    const corrupt = "{not valid json\n"
    await fs.writeFile(h.registryPath, corrupt)
    expect((await h.call<ToolError>("workspace_list")).error.code).toBe("INVALID_REGISTRY")
    expect((await h.call<ToolError>("workspace_create", { name: "second" })).error.code).toBe("INVALID_REGISTRY")
    expect(await fs.readFile(h.registryPath, "utf8")).toBe(corrupt)
    const invalid = JSON.stringify({ version: 1, active: "missing", workspaces: {} })
    await fs.writeFile(h.registryPath, invalid)
    expect((await h.call<ToolError>("workspace_list")).error.code).toBe("INVALID_REGISTRY")
    expect(await fs.readFile(h.registryPath, "utf8")).toBe(invalid)
  })

  test("multiple plugin instances serialize writes without losing entries", async () => {
    const second = await h.start()
    await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      if (index % 2) return h.call("workspace_create", { name: `workspace-${index}` })
      return second.tools["workspace_create"]!.execute({ name: `workspace-${index}` }, h.context)
    }))
    expect(Object.keys((await h.call<Registry>("workspace_list")).workspaces)).toHaveLength(10)
    expect(await fs.exists(`${h.registryPath}.lock`)).toBe(false)
  })

  test("registry paths with Windows 8.3 ancestors are canonicalized even before the parent exists", async () => {
    await h.load({ registryPath: path.join(h.originalBase, "short-path-registry", "workspaces.json") })
    await h.call("workspace_create", { name: "short-path" })
    expect((await h.call<Registry>("workspace_list")).active).toBe("short-path")
    expect(await fs.exists(path.join(h.base, "short-path-registry", "workspaces.json"))).toBe(true)
  })

  test("a stale lock from a dead process can be recovered without touching registry data", async () => {
    await h.call("workspace_create", { name: "before-crash" })
    const lock = `${h.registryPath}.lock`
    const deadPid = 2_147_483_646
    await fs.writeFile(lock, JSON.stringify({ pid: deadPid, token: "dead-owner", createdAt: 0 }))
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lock, old, old)
    await h.call("workspace_create", { name: "after-crash" })
    expect(Object.keys((await h.call<Registry>("workspace_list")).workspaces).sort()).toEqual(["after-crash", "before-crash"])
    expect(await fs.exists(lock)).toBe(false)
  })

  test("invalid reserved workspace keys fail validation without prototype pollution", async () => {
    await h.call("workspace_create", { name: "initial" })
    const invalid = '{"version":1,"active":null,"workspaces":{"__proto__":{"name":"__proto__","createdAt":"","roots":[]}}}'
    await fs.writeFile(h.registryPath, invalid)
    expect((await h.call<ToolError>("workspace_list")).error.code).toBe("INVALID_REGISTRY")
    expect(await fs.readFile(h.registryPath, "utf8")).toBe(invalid)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  test("PowerShell 5.1 UTF-8 BOM project registries are accepted", async () => {
    const override = path.join(h.directory, ".opencode", "workspace.json")
    await fs.mkdir(path.dirname(override))
    await fs.writeFile(override, '\ufeff{"version":1,"active":null,"workspaces":{}}')
    await h.load({ registryPath: undefined })
    await h.call("workspace_create", { name: "bom" })
    expect((await h.call<Registry>("workspace_list")).active).toBe("bom")
  })
})

describe("paths, permissions and reads", () => {
  test("normalizes backslashes, quoted paths, ~ and $HOME; preserves spaces", async () => {
    await h.call("workspace_create", { name: "paths" })
    const added = await h.call<Added>("workspace_add", { workspace: "paths", path: `"${h.docs}"`, alias: "docs" })
    expect(added.root.path).not.toContain("\\")
    expect(added.root.path).toContain("external docs")
    if (process.platform === "win32") {
      expect((await h.call<Added>("workspace_add", { workspace: "paths", path: h.docs.replaceAll("/", "\\") })).added).toBe(false)
    }
    const home = unix(await fs.realpath(homedir()))
    expect((await h.call<Added>("workspace_add", { workspace: "paths", path: "~", alias: "home" })).root.path).toBe(home)
    expect((await h.call<Added>("workspace_add", { workspace: "paths", path: "$HOME" })).added).toBe(false)
    expect((await h.call<Added>("workspace_add", { workspace: "paths", path: "${HOME}" })).added).toBe(false)
    // No tests enumerate or read the real home directory; only its stat is used.
  })

  test("relative add and parent traversal request a separate, non-persistent confirmation", async () => {
    await h.call("workspace_create", { name: "test" })
    const raw = `..${path.sep}external docs`
    const added = await h.call<Added>("workspace_add", { workspace: "test", path: raw })
    expect(added.root.path).toBe(unix(await fs.realpath(h.docs)))
    expect(h.permissions.find((request) => request.action === "workspace_escape")).toMatchObject({ save: [], resources: [unix(h.docs)] })
    expect(h.permissions.some((request) => request.action === "external_directory")).toBe(true)
    const file = await h.write(h.docs, "file.txt", "hello")
    await fs.mkdir(path.join(h.docs, "nested"))
    h.permissions.length = 0
    expect((await h.call<ReadResult>("workspace_read", { path: `${added.root.alias}:/nested/../file.txt` })).content).toBe("hello")
    expect(h.permissions.some((request) => request.action === "workspace_escape")).toBe(true)
    expect((await h.call<ReadResult>("workspace_read", { path: file })).content).toBe("hello")
  })

  test("permission rejection propagates rather than being converted into a successful tool output", async () => {
    await h.call("workspace_create", { name: "test" })
    const rejected = new Error("Permission rejected by user")
    h.denyPermission(rejected)
    await expect(h.call("workspace_add", { workspace: "test", path: h.docs })).rejects.toBe(rejected)
    expect((await h.call<Registry>("workspace_list")).workspaces["test"]!.roots).toEqual([])
  })

  test("no active root, inactive workspace, alias escape and prefix-confusion are denied", async () => {
    await h.write(h.docs, "file.txt", "hello")
    await h.write(h.outside, "secret.txt", "outside")
    expect((await h.call<ToolError>("workspace_glob", { pattern: "**/*" })).error.code).toBe("NO_ACTIVE_WORKSPACE")
    await h.createAndAdd()
    expect((await h.call<ToolError>("workspace_read", { path: path.join(h.outside, "secret.txt") })).error.code).toBe("OUTSIDE_ROOT")
    expect((await h.call<ToolError>("workspace_read", { path: "docs:/../external-src/file.txt" })).error.code).toBe("OUTSIDE_ROOT")
    const sibling = `${h.docs}-shadow`
    await fs.mkdir(sibling)
    await fs.writeFile(path.join(sibling, "file.txt"), "outside")
    expect((await h.call<ToolError>("workspace_read", { path: path.join(sibling, "file.txt") })).error.code).toBe("OUTSIDE_ROOT")
    await h.call("workspace_create", { name: "empty" })
    expect((await h.call<ToolError>("workspace_read", { path: path.join(h.docs, "file.txt") })).error.code).toBe("OUTSIDE_ROOT")
  })

  test("sensitive files are blocked before any file content is returned", async () => {
    await h.createAndAdd()
    for (const file of [".env", ".env.local", "config.env", "private.pem", ".ssh/id_rsa", ".aws/credentials", "UPPER.ENV"]) {
      await h.write(h.docs, file, "NEVER_PRINT_THIS")
      expect((await h.call<ToolError>("workspace_read", { path: `docs:/${file}` })).error.code).toBe("DENIED_PATH")
    }
    expect(JSON.stringify(await h.call("workspace_glob", { pattern: "**/*" }))).not.toContain(".env")
    expect((await h.call<GrepResult>("workspace_grep", { pattern: "NEVER_PRINT_THIS" })).matches).toEqual([])
    expect((await h.call<ToolError>("workspace_add", { workspace: "research-xyz", path: path.join(h.docs, ".ssh") })).error.code).toBe("DENIED_PATH")
  })

  test("junction/symlink escape is denied for reads and skipped in browse and scans", async () => {
    await h.write(h.outside, "secret.txt", "NEVER_PRINT_THIS")
    await fs.symlink(h.outside, path.join(h.docs, "jump"), process.platform === "win32" ? "junction" : "dir")
    await h.createAndAdd()
    expect((await h.call<ToolError>("workspace_read", { path: "docs:/jump/secret.txt" })).error.code).toBe("OUTSIDE_ROOT")
    expect((await h.call<GlobResult>("workspace_glob", { pattern: "**/*", alias: "docs" })).files).toEqual([])
    expect((await h.call<BrowseResult>("workspace_browse", { path: h.docs })).directories).toEqual([])
  })

  test("aliases cannot reset the root with an absolute drive suffix", async () => {
    await h.createAndAdd()
    expect((await h.call<ToolError>("workspace_read", { path: "docs://outside/file.txt" })).error.code).toBe("INVALID_PATH")
    expect((await h.call<ToolError>("workspace_read", { path: "docs:/C:/outside/file.txt" })).error.code).toBe("INVALID_PATH")
  })

  test("missing saved roots can still be listed and removed by alias", async () => {
    await h.createAndAdd()
    await fs.rename(h.docs, `${h.docs}-offline`)
    expect((await h.call<Registry>("workspace_list")).workspaces["research-xyz"]!.roots).toHaveLength(2)
    expect((await h.call<ToolError>("workspace_status")).error.code).toBe("ENOENT")
    await h.call("workspace_remove", { workspace: "research-xyz", aliasOrPath: "docs" })
    expect((await h.call<Status>("workspace_status")).roots).toEqual([{ alias: "src", path: unix(h.src) }])
  })

  test("a registered root replaced by a junction requires explicit re-registration", async () => {
    await h.createAndAdd()
    await fs.rename(h.docs, `${h.docs}-original`)
    await fs.symlink(h.outside, h.docs, process.platform === "win32" ? "junction" : "dir")
    expect((await h.call<ToolError>("workspace_glob", { pattern: "**/*" })).error.code).toBe("ROOT_CHANGED")
    await h.call("workspace_remove", { workspace: "research-xyz", aliasOrPath: "docs" })
    expect(await h.call("workspace_status")).toMatchObject({ roots: [{ alias: "src" }] })
  })

  test("read is byte-bounded, handles exact limits and does not split UTF-8 characters", async () => {
    await h.createAndAdd()
    const limit = 200 * 1024
    await h.write(h.docs, "large.txt", "a".repeat(limit - 1) + "🙂tail")
    const large = await h.call<ReadResult>("workspace_read", { path: "docs:/large.txt" })
    expect(large.truncated).toBe(true)
    expect(large.content).toBe("a".repeat(limit - 1))
    expect(Buffer.byteLength(large.content)).toBeLessThanOrEqual(limit)
    await h.write(h.docs, "exact.txt", "b".repeat(limit))
    expect((await h.call<ReadResult>("workspace_read", { path: "docs:/exact.txt" })).truncated).toBe(false)
    await h.write(h.docs, "empty.txt", "")
    expect(await h.call("workspace_read", { path: "docs:/empty.txt" })).toEqual({ content: "", truncated: false })
    await h.write(h.docs, "binary.dat", Buffer.from([1, 0, 2]))
    expect((await h.call<ToolError>("workspace_read", { path: "docs:/binary.dat" })).error.code).toBe("BINARY_FILE")
    expect((await h.call<ToolError>("workspace_read", { path: "docs:/missing.txt" })).error.code).toBe("ENOENT")
    expect((await h.call<ToolError>("workspace_read", { path: "docs:/" })).error.code).toBe("NOT_FILE")
  })

  test.skipIf(process.platform !== "win32")("rejects ADS, drive-relative, device paths and trailing-dot bypasses", async () => {
    await h.createAndAdd()
    for (const raw of ["docs:/file.txt:stream", "docs:/.env.", "C:relative", "\\\\?\\C:\\data", "C:/data/NUL.txt"]) {
      expect((await h.call<ToolError>("workspace_read", { path: raw })).error.code).toBe("INVALID_PATH")
    }
  })

  test("cancellation is respected", async () => {
    h.controller.abort(new Error("Stopped"))
    await expect(h.call("workspace_list")).rejects.toThrow("Stopped")
  })
})

describe("glob, ignore rules, status and grep", () => {
  test("honors root/nested .gitignore including negation, even without a git repo", async () => {
    await h.createAndAdd()
    await h.write(h.docs, ".gitignore", "ignored.md\n*.log\nblocked-dir/\n!blocked-dir/surprise.md\n")
    await h.write(h.docs, "visible.md", "deprecated visible")
    await h.write(h.docs, "ignored.md", "deprecated ignored")
    await h.write(h.docs, ".hidden", "deprecated hidden")
    await h.write(h.docs, "sub/.gitignore", "blocked.md\n!keep.log\n")
    await h.write(h.docs, "sub/blocked.md", "deprecated nested ignored")
    await h.write(h.docs, "sub/keep.log", "deprecated re-included")
    await h.write(h.docs, "sub/drop.log", "deprecated ignored log")
    await h.write(h.docs, "blocked-dir/surprise.md", "deprecated cannot re-include parent")
    const result = await h.call<GlobResult>("workspace_glob", { pattern: "docs:/**/*" })
    expect(result.files.sort()).toEqual(["docs:/.gitignore", "docs:/.hidden", "docs:/sub/.gitignore", "docs:/sub/keep.log", "docs:/visible.md"].sort())
    expect((await h.call<Status>("workspace_status")).fileCount).toBe(5)
    const grep = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated", alias: "docs" })
    expect(grep.matches.map((match) => match.file).sort()).toEqual(["docs:/.hidden", "docs:/sub/keep.log", "docs:/visible.md"].sort())
  })

  test("glob sorts by modification time and caps output at 200", async () => {
    await h.createAndAdd()
    await Promise.all(Array.from({ length: 205 }, async (_, index) => {
      const file = await h.write(h.docs, `file-${String(index).padStart(3, "0")}.txt`, "text")
      const date = new Date(1_700_000_000_000 + index * 2000)
      await fs.utimes(file, date, date)
    }))
    const result = await h.call<GlobResult>("workspace_glob", { pattern: "**/*.txt", alias: "docs" })
    expect(result.files).toHaveLength(200)
    expect(result.files[0]).toBe("docs:/file-204.txt")
    expect(result.files.at(-1)).toBe("docs:/file-005.txt")
    expect(result.truncated).toBe(true)
  })

  test("overlapping roots count a physical file only once", async () => {
    await h.createAndAdd()
    const nested = path.join(h.docs, "nested")
    await h.write(nested, "file.txt", "hello")
    await h.call("workspace_add", { workspace: "research-xyz", path: nested, alias: "nested" })
    expect((await h.call<Status>("workspace_status")).fileCount).toBe(1)
    expect((await h.call<GlobResult>("workspace_glob", { pattern: "**/*" })).files).toHaveLength(1)
    expect((await h.call<GlobResult>("workspace_glob", { pattern: "**/*", alias: "nested" })).files).toEqual(["nested:/file.txt"])
  })

  test("rejects glob traversal, alias conflicts and unknown aliases", async () => {
    await h.createAndAdd()
    expect((await h.call<ToolError>("workspace_glob", { pattern: "../**" })).error.code).toBe("INVALID_PATTERN")
    expect((await h.call<ToolError>("workspace_glob", { pattern: "docs:/**/*.md", alias: "src" })).error.code).toBe("INVALID_PATTERN")
    expect((await h.call<ToolError>("workspace_glob", { pattern: "**/*", alias: "unknown" })).error.code).toBe("UNKNOWN_ALIAS")
    expect((await h.call<ToolError>("workspace_grep", { pattern: "x", include: "../**" })).error.code).toBe("INVALID_PATTERN")
  })

  test("fs+regex grep returns file/line/text, honors include, and excludes large and binary files", async () => {
    await h.createAndAdd()
    await h.write(h.src, "api.ts", "current\r\ndeprecated API\r\n")
    await h.write(h.src, "notes.md", "deprecated docs")
    await h.write(h.src, "large.ts", "deprecated\n" + "x".repeat(200 * 1024))
    await h.write(h.src, "binary.ts", Buffer.from("deprecated\0binary"))
    const result = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated", alias: "src", include: "**/*.ts" })
    expect(result).toEqual({ matches: [{ file: "src:/api.ts", line: 2, text: "deprecated API" }], truncated: false, engine: "fs+regex" })
    expect((await h.call<ToolError>("workspace_grep", { pattern: "[" })).error.code).toBe("INVALID_PATTERN")
  })

  test("grep caps matching lines at 100 and clips very long lines", async () => {
    await h.createAndAdd()
    await h.write(h.src, "many.txt", Array.from({ length: 120 }, (_, index) => `deprecated ${index}`).join("\n"))
    const result = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated", alias: "src" })
    expect(result.matches).toHaveLength(100)
    expect(result.truncated).toBe(true)
    expect(result.matches[0]).toEqual({ file: "src:/many.txt", line: 1, text: "deprecated 0" })
    await h.write(h.src, "long.txt", "deprecated " + "a".repeat(10_000))
    const long = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated", alias: "src", include: "long.txt" })
    expect(long.matches[0]!.text).toEndWith("[line truncated]")
    expect(long.matches[0]!.text.length).toBeLessThan(2100)
  })

  test("fallback regex cannot block the server event loop indefinitely", async () => {
    await h.createAndAdd()
    await h.write(h.src, "pathological.txt", "a".repeat(190_000) + "!")
    const pending = h.call<ToolError>("workspace_grep", { pattern: "^(a|aa)+$", alias: "src" })
    await Bun.sleep(100)
    // A different tool can still run while the worker is evaluating its regex.
    expect((await h.call<Status>("workspace_status")).active).toBe("research-xyz")
    const result = await pending
    expect(result.error.code).toBe("REGEX_TIMEOUT")
    expect((await h.call<Status>("workspace_status")).active).toBe("research-xyz")
  }, 10_000)

  test("real rg runs via Bun shell with spaced paths, filtering, include and secret protection", async () => {
    await fs.access(rgPath)
    process.env.PATH = `${path.dirname(rgPath)}${path.delimiter}${oldPath ?? ""}`
    expect(Bun.which("rg", { PATH: process.env.PATH! })).not.toBeNull()
    await h.load({ ripgrep: true })
    await h.createAndAdd()
    await h.write(h.docs, "API spec.md", "current\r\ndeprecated docs\r\n")
    await h.write(h.docs, ".env", "deprecated NEVER_PRINT")
    await h.write(h.docs, ".gitignore", "ignored.md\n")
    await h.write(h.docs, "ignored.md", "deprecated NEVER_PRINT")
    await h.write(h.docs, "other.txt", "deprecated wrong include")
    const result = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated", alias: "docs", include: "**/*.md" })
    expect(result).toEqual({ matches: [{ file: "docs:/API spec.md", line: 2, text: "deprecated docs" }], truncated: false, engine: "rg" })
  })

  test("an rg-unsupported expression falls back to isolated JavaScript regex", async () => {
    process.env.PATH = `${path.dirname(rgPath)}${path.delimiter}${oldPath ?? ""}`
    await h.load({ ripgrep: true })
    await h.createAndAdd()
    await h.write(h.src, "api.ts", "deprecated API")
    const result = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated(?= API)", alias: "src" })
    expect(result.engine).toBe("fs+regex")
    expect(result.matches[0]!.text).toBe("deprecated API")
  })

  test("rg batches keep global output at 100 matches", async () => {
    process.env.PATH = `${path.dirname(rgPath)}${path.delimiter}${oldPath ?? ""}`
    await h.load({ ripgrep: true })
    await h.createAndAdd()
    await Promise.all(Array.from({ length: 20 }, (_, index) => h.write(h.docs, `part ${index}.txt`, "deprecated\n".repeat(8))))
    const result = await h.call<GrepResult>("workspace_grep", { pattern: "deprecated", alias: "docs" })
    expect(result.engine).toBe("rg")
    expect(result.matches).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })
})

describe("picker, native V2 hooks and compaction", () => {
  test("folder browsing lists metadata only and does not add roots", async () => {
    await h.createAndAdd()
    await h.write(h.outside, "folder/visible.txt", "file contents should never be in browse output")
    await h.write(h.outside, ".ssh/id_rsa", "NEVER_PRINT")
    await h.write(h.outside, "file.txt", "not a folder")
    const result = await h.call<BrowseResult>("workspace_browse", { path: h.outside })
    expect(result.current).toBe(unix(await fs.realpath(h.outside)))
    expect(result.parent).toBe(unix(h.base))
    expect(result.directories).toEqual([{ name: "folder", path: unix(path.join(h.outside, "folder")) }])
    expect(JSON.stringify(result)).not.toContain("visible.txt")
    expect((await h.call<Registry>("workspace_list")).workspaces["research-xyz"]!.roots).toHaveLength(2)
    expect((await h.call<ToolError>("workspace_browse", { path: path.join(h.outside, "missing") })).error.code).toBe("ENOENT")
  })

  test("saved mutations emit notification events and fresh context is injected before every model request", async () => {
    await h.createAndAdd()
    expect(h.toasts.some((toast) => toast.variant === "success" && toast.message.includes("workspace saved"))).toBe(true)
    const event = await h.inject()
    const text = JSON.stringify(event.system)
    expect(text).toContain('research-xyz')
    expect(text).toContain("docs->")
    expect(text).toContain("cwd/worktree are unchanged")
    await h.call("workspace_create", { name: "other" })
    expect(JSON.stringify((await h.inject()).system)).toContain("other")
    expect(JSON.stringify((await h.inject()).system)).not.toContain("docs->")
  })

  test("UI transport failure cannot invalidate a successful save", async () => {
    h.failUI()
    await h.call("workspace_create", { name: "saved-without-tui" })
    expect((await h.call<Registry>("workspace_list")).active).toBe("saved-without-tui")
  })

  test("permission evaluation only suggests approval for canonical in-root paths and never auto-allows", async () => {
    await h.createAndAdd()
    const request = await h.evaluate({ action: "external_directory", effect: "ask", resources: [`${unix(h.docs)}/**`], message: "Existing policy message" })
    expect(request.effect).toBe("ask")
    expect(request.message).toStartWith("Existing policy message")
    expect(request.message).toContain("approval remains your choice")
    const outside = await h.evaluate({ action: "external_directory", effect: "ask", resources: [`${unix(h.outside)}/**`] })
    const sensitive = await h.evaluate({ action: "external_directory", effect: "ask", resources: [`${unix(h.docs)}/.env`] })
    expect(outside.message).toBeUndefined()
    expect(sensitive.message).toBeUndefined()
    expect(outside.effect).toBe("ask")
    expect(sensitive.effect).toBe("ask")
  })

  test("traversal checks escalate our default allows to ask, but never weaken a deny or alter another plugin's action", async () => {
    const request = { action: "workspace_escape", resources: [unix(h.docs)], metadata: { workspaceManager: true } }
    expect((await h.evaluate({ ...request, effect: "allow" })).effect).toBe("ask")
    expect((await h.evaluate({ ...request, effect: "deny" })).effect).toBe("deny")
    expect((await h.evaluate({ action: "workspace_escape", resources: [unix(h.docs)], effect: "allow" })).effect).toBe("allow")
  })

  test("compaction preserves active mapping, including another plugin's supplied summary", async () => {
    await h.createAndAdd()
    const event = await h.inject("compaction", "Existing custom compaction summary")
    expect(event.system).toHaveLength(1)
    const first = event.system[0]!
    expect(first.type).toBe("text")
    if (first.type !== "text") throw new Error("Expected text system context")
    expect(first.text).toContain('Active workspace "research-xyz"')
    expect(first.text).toContain(`docs->${JSON.stringify(unix(h.docs))}`)
    expect(first.text).toContain("workspace_status")
    expect(event.result?.summary).toStartWith("Existing custom compaction summary")
    expect(event.result?.summary).toContain("src->")
    expect(event.result?.metadata).toEqual({ preserve: true })
    await h.load()
    expect(JSON.stringify((await h.inject("compaction")).system)).toContain("research-xyz")
  })

  test("an invalid registry does not break model requests or compaction and no stale mapping is injected", async () => {
    await h.createAndAdd()
    await fs.writeFile(h.registryPath, "{broken")
    expect(JSON.stringify((await h.inject()).system)).toContain("Workspace registry unavailable")
    const event = await h.inject("compaction")
    expect(JSON.stringify(event.system)).not.toContain("docs->")
    expect((await h.call<ToolError>("workspace_list")).error.code).toBe("INVALID_REGISTRY")
  })

  test("native execution context uses the session subpath and does not follow a session moved to another location", async () => {
    const nested = path.join(h.directory, "nested")
    await fs.mkdir(nested)
    h.setSubpath("nested")
    expect((await h.call<BrowseResult>("workspace_browse")).current).toBe(unix(nested))
    h.setSessionDirectory(h.outside)
    await expect(h.call("workspace_list")).rejects.toThrow("Session location changed")
  })

  test("native permission calls carry the tool source and signal/progress adapters preserve V2 metadata", async () => {
    await h.createAndAdd()
    expect(h.permissions[0]).toMatchObject({
      sessionID: h.context.sessionID,
      agent: h.context.agent,
      source: { type: "tool", messageID: h.context.messageID, id: h.context.id },
      action: "external_directory",
      metadata: { workspaceManager: true },
    })
    await h.call("workspace_status")
    expect(h.progress.at(-1)).toMatchObject({ title: "Workspace: research-xyz (2 roots)", active: "research-xyz" })
  })

  test("Zod argument validation remains enforced behind the V2 JSON schemas", async () => {
    await expect(h.call("workspace_create", { name: "__proto__" })).rejects.toThrow("Invalid workspace tool arguments")
    await expect(h.call("workspace_add", { workspace: "test", path: h.docs, alias: "invalid alias" })).rejects.toThrow("Invalid workspace tool arguments")
  })

  test("built-in reads cannot bypass the workspace wrappers or sensitive-path guard", async () => {
    await h.createAndAdd()
    await h.write(h.docs, "file.txt", "hello")
    await expect(h.before("read", { filePath: "docs:/file.txt" })).rejects.toThrow("alias:/ paths belong")
    await expect(h.before("read", { filePath: path.join(h.docs, "file.txt") })).rejects.toThrow("Use workspace_read")
    await expect(h.before("read", { filePath: path.join(h.docs, ".env") })).rejects.toThrow("Sensitive paths are blocked")
    await expect(h.before("workspace_read", { path: "docs:/file.txt" })).resolves.toBeUndefined()
  })

  test.skipIf(process.platform !== "win32")("README commands parse with the real Windows PowerShell 5.1 parser", async () => {
    const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8")
    const scripts = [...readme.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((match) => match[1]!)
    expect(scripts.length).toBeGreaterThan(0)
    const parser = `
      $tokens = $null
      $errors = $null
      [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null
      if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }
      [Console]::Out.Write($PSVersionTable.PSVersion.Major)
    `
    const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", parser], {
      stdin: new Blob([scripts.join("\n\n")]), stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toBe("5")
  }, 10_000)
})
