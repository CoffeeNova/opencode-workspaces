import { Plugin } from "@opencode/plugin"
import { Error as ToolError, type ToolContext as NativeToolContext } from "@opencode/plugin/promise/tool"
import { $ } from "bun"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { WorkspaceError } from "../../src/domain.ts"
import { registryLock } from "../../src/infrastructure/registry-lock.ts"
import { boundedRead, decode, globScope, RegexMatcher, searchPattern, walk, type FileEntry } from "../../src/infrastructure/search.ts"
import { WorkspaceNotifications } from "./workspace-manager-notifications/rpc.ts"

// V2 entrypoint; helpers are private and all tools/hooks register through setup.
const READ_LIMIT = 200 * 1024
const REGISTRY_LIMIT = 4 * 1024 * 1024
const GLOB_LIMIT = 200
const GREP_LIMIT = 100
const BROWSE_LIMIT = 100
const SCHEMA_URL = "https://example.com/workspace-manager.json"
const WINDOWS = process.platform === "win32"
const FORBIDDEN_NAMES = new Set(["__proto__", "prototype", "constructor"])

const Name = z.string().trim().min(1).max(100).refine(
  (value) => !/[\x00-\x1f\x7f]/.test(value) && !FORBIDDEN_NAMES.has(value.toLowerCase()),
  "Use a printable workspace name other than a reserved object property",
)
const Alias = z.string().min(1).regex(/^[a-z0-9_-]+$/)
const WorkspaceRoot = z.object({ alias: Alias, path: z.string().min(3) })
const Workspace = z.object({
  name: Name,
  createdAt: z.string(),
  roots: z.array(WorkspaceRoot).max(20),
})
// Zod 4 requires both the key and value schemas for z.record().
const Registry = z.object({
  $schema: z.string().optional().default(SCHEMA_URL),
  version: z.literal(1),
  active: z.string().nullable(),
  workspaces: z.record(z.string(), Workspace),
}).superRefine((registry, ctx) => {
  if (registry.active !== null && !Object.hasOwn(registry.workspaces, registry.active)) {
    ctx.addIssue({ code: "custom", message: "Active workspace does not exist" })
  }
  for (const [key, workspace] of Object.entries(registry.workspaces)) {
    if (key !== workspace.name || !Name.safeParse(key).success) {
      ctx.addIssue({ code: "custom", message: `Invalid workspace key: ${JSON.stringify(key)}` })
    }
    const aliases = new Set<string>()
    const paths = new Set<string>()
    for (const root of workspace.roots) {
      if (aliases.has(root.alias) || paths.has(pathKey(root.path))) {
        ctx.addIssue({ code: "custom", message: `Duplicate root in ${JSON.stringify(key)}` })
      }
      aliases.add(root.alias)
      paths.add(pathKey(root.path))
    }
  }
})

type Root = z.infer<typeof WorkspaceRoot>
type WorkspaceData = z.infer<typeof Workspace>
type RegistryData = z.infer<typeof Registry>
type Match = { file: string; line: number; text: string }

// Keep filesystem operations independent of the server's tool transport.
type ToolContext = Pick<NativeToolContext, "sessionID" | "agent" | "messageID" | "id"> & {
  directory: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): Promise<void>
  ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void>
}

function workspaceTool<Args extends z.ZodRawShape>(definition: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>
}) {
  const schema = z.object(definition.args)
  return {
    description: definition.description,
    input: { ...z.toJSONSchema(schema, { target: "draft-7", io: "input" }), additionalProperties: false },
    async execute(input: unknown, context: ToolContext) {
      const parsed = schema.safeParse(input)
      if (!parsed.success) throw new ToolError({ message: `Invalid workspace tool arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` })
      return definition.execute(parsed.data, context)
    },
  }
}

function fail(code: string, message: string): never {
  throw new WorkspaceError(code, message)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function slash(value: string): string {
  return value.replaceAll("\\", "/")
}

function pathKey(value: string): string {
  const normalized = slash(value).replace(/\/$/, "")
  return WINDOWS ? normalized.toLowerCase() : normalized
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function expanded(raw: string): string {
  let value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  value = slash(value)
  if (!value || /[\x00-\x1f\x7f]/.test(value)) fail("INVALID_PATH", "Path is empty or contains control characters")
  value = value.replace(/^~(?=\/|$)/, slash(homedir()))
  value = value.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, slash(homedir()))
  if (/^\/\/[?.]\//.test(value) || value.startsWith("/??/")) {
    fail("INVALID_PATH", "Windows device and extended-namespace paths are not supported")
  }
  if (WINDOWS) {
    if (/^[a-z]:($|[^/])/i.test(value)) fail("INVALID_PATH", "Use an absolute drive path, for example C:/data")
    if (value.startsWith("/") && !value.startsWith("//")) {
      fail("INVALID_PATH", "A Windows absolute path must include its drive")
    }
    const withoutDrive = value.replace(/^[a-z]:/i, "")
    if (/[<>:"|?*]/.test(withoutDrive)) fail("INVALID_PATH", "Path contains Windows wildcards, a device name, or an alternate data stream")
    for (const part of withoutDrive.split("/")) {
      if (part === "." || part === ".." || part === "") continue
      if (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
        fail("INVALID_PATH", "Windows reserved names and trailing dots/spaces are not supported")
      }
    }
  } else if (/^[a-z]:/i.test(value) || value.startsWith("//")) {
    fail("INVALID_PATH", "This host cannot resolve a Windows drive or UNC path")
  }
  return value
}

function absolute(raw: string, base: string): string {
  const resolved = slash(path.resolve(base, expanded(raw)))
  return WINDOWS ? resolved.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : resolved
}

function denied(value: string): boolean {
  // Intentionally stricter than just ~/.ssh and ~/.aws: never walk these names.
  return slash(value).split("/").some((part) => {
    const name = part.toLowerCase()
    return name === ".ssh" || name === ".aws" || name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name.endsWith(".pem")
  })
}

function assertNotDenied(value: string): void {
  if (denied(value)) fail("DENIED_PATH", "Sensitive paths are blocked (*.env, .env.*, *.pem, .ssh/**, .aws/**)")
}

async function confirmTraversal(raw: string, base: string, target: string, context: ToolContext): Promise<void> {
  if (!slash(raw).split("/").includes("..")) return
  await context.ask({
    permission: "workspace_escape",
    patterns: [target],
    always: [],
    metadata: { reason: "Confirm a path containing parent-directory traversal", from: base, to: target },
  })
}

async function canonicalDirectory(raw: string, base: string): Promise<string> {
  assertNotDenied(expanded(raw))
  const candidate = absolute(raw, base)
  assertNotDenied(candidate)
  const info = await fs.stat(candidate)
  if (!info.isDirectory()) fail("NOT_DIRECTORY", `Not a directory: ${candidate}`)
  const canonical = absolute(await fs.realpath(candidate), base)
  assertNotDenied(canonical)
  return canonical
}

function emptyRegistry(): RegistryData {
  return { $schema: SCHEMA_URL, version: 1, active: null, workspaces: {} }
}

async function canonicalStoragePath(file: string, base: string): Promise<string> {
  // The file/parent might not exist yet. Resolve the nearest existing ancestor,
  // including Windows 8.3 names and home-directory junctions, before writing.
  const candidate = absolute(file, base)
  let parent = path.dirname(candidate)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await fs.realpath(parent)
      if (!(await fs.stat(canonical)).isDirectory()) fail("NOT_DIRECTORY", "Registry parent is not a directory")
      return slash(path.join(canonical, ...missing, path.basename(candidate)))
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
      const next = path.dirname(parent)
      if (next === parent) throw error
      missing.unshift(path.basename(parent))
      parent = next
    }
  }
}

class RegistryStore {
  constructor(readonly file: string, private readonly directory: string) {}

  async read(signal?: AbortSignal): Promise<RegistryData> {
    let text: string
    try {
      const result = await boundedRead(this.file, REGISTRY_LIMIT, signal)
      if (result.truncated) fail("INVALID_REGISTRY", "Workspace registry exceeds 4 MB; no data was overwritten")
      text = decode(result.bytes)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptyRegistry()
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return fail("INVALID_REGISTRY", `Invalid JSON in ${this.file}; no data was overwritten`)
    }
    // Zod defensively skips __proto__ record keys. Detect them before parsing
    // so invalid input cannot be silently dropped on the next registry write.
    if (typeof json === "object" && json !== null && "workspaces" in json && typeof json.workspaces === "object" && json.workspaces !== null) {
      for (const key of Object.keys(json.workspaces)) {
        const name = Name.safeParse(key)
        if (!name.success || name.data !== key) fail("INVALID_REGISTRY", `Invalid workspace key: ${JSON.stringify(key)}`)
      }
    }
    const parsed = Registry.safeParse(json)
    if (!parsed.success) fail("INVALID_REGISTRY", `Invalid workspace registry: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
    for (const workspace of Object.values(parsed.data.workspaces)) {
      const paths = new Set<string>()
      for (const root of workspace.roots) {
        if (!path.isAbsolute(slash(root.path)) || slash(root.path).split("/").includes("..")) {
          fail("INVALID_REGISTRY", "Stored root paths must be absolute, without parent traversal")
        }
        root.path = absolute(root.path, this.directory)
        assertNotDenied(root.path)
        if (paths.has(pathKey(root.path))) fail("INVALID_REGISTRY", "Stored roots contain duplicate normalized paths")
        paths.add(pathKey(root.path))
      }
    }
    return parsed.data
  }

  private async lock(signal: AbortSignal): Promise<() => Promise<void>> {
    return registryLock(this.file, signal)
  }

  async mutate<T>(signal: AbortSignal, update: (registry: RegistryData) => T): Promise<{ registry: RegistryData; result: T }> {
    const unlock = await this.lock(signal)
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      const registry = await this.read(signal)
      const result = update(registry)
      const validated = Registry.safeParse(registry)
      if (!validated.success) fail("INVALID_REGISTRY", validated.error.issues.map((issue) => issue.message).join("; "))
      const serialized = `${JSON.stringify(validated.data, null, 2)}\n`
      if (Buffer.byteLength(serialized, "utf8") > REGISTRY_LIMIT) fail("REGISTRY_FULL", "Workspace registry would exceed 4 MB; no data was overwritten")
      signal.throwIfAborted()
      const handle = await fs.open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(serialized, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Same-directory rename is atomic; never unlink the original first.
      // Windows indexers/antivirus can briefly hold a destination handle.
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        try {
          await fs.rename(temporary, this.file)
          break
        } catch (error) {
          if (!WINDOWS || attempt === 7 || !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")) throw error
          await delay(20 * 2 ** attempt, undefined, { signal })
        }
      }
      return { registry: validated.data, result }
    } finally {
      try {
        await fs.unlink(temporary)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      } finally {
        await unlock()
      }
    }
  }
}

function workspace(registry: RegistryData, name: string): WorkspaceData {
  if (!Object.hasOwn(registry.workspaces, name)) fail("UNKNOWN_WORKSPACE", `Workspace not found: ${JSON.stringify(name)}`)
  return registry.workspaces[name]!
}

function activeRoots(registry: RegistryData): Root[] {
  return registry.active === null ? [] : workspace(registry, registry.active).roots
}

function activeContext(registry: RegistryData): string {
  const roots = activeRoots(registry)
  const heading = registry.active === null
    ? "Active workspace (none)."
    : `Active workspace ${JSON.stringify(registry.active)}: ${roots.map((root) => `${root.alias}->${JSON.stringify(root.path)}`).join(", ") || "(no roots)"}.`
  return `${heading}\nVirtual workspace only; cwd/worktree are unchanged. Use workspace_read, workspace_glob, and workspace_grep with alias:/ paths. Old mappings are snapshots; workspace_status is authoritative. external_directory permission may still be required. Never bypass a denied path with another tool.`
}

async function externalPermission(target: string, context: ToolContext): Promise<void> {
  const current = absolute(await fs.realpath(context.directory), context.directory)
  if (inside(current, target)) return
  const pattern = `${target.replace(/\/$/, "")}/**`
  await context.ask({
    permission: "external_directory",
    patterns: [pattern],
    always: [pattern],
    metadata: { path: target, reason: "Virtual workspace access does not change the session directory" },
  })
}

async function checkedRoots(registry: RegistryData, context: ToolContext, alias?: string): Promise<Root[]> {
  if (registry.active === null) fail("NO_ACTIVE_WORKSPACE", "No active workspace. Run /workspace to create or switch one")
  const roots = activeRoots(registry).filter((root) => alias === undefined || root.alias === alias)
  if (alias !== undefined && roots.length === 0) fail("UNKNOWN_ALIAS", `Unknown active root alias: ${JSON.stringify(alias)}`)
  for (const root of roots) {
    const canonical = await canonicalDirectory(root.path, context.directory)
    if (pathKey(canonical) !== pathKey(root.path)) fail("ROOT_CHANGED", `Root ${root.alias} moved or became a link; remove and re-add it`)
    await externalPermission(root.path, context)
  }
  return roots
}

async function resolveRead(raw: string, registry: RegistryData, context: ToolContext): Promise<{ file: string; root: Root }> {
  const text = slash(raw.trim())
  const prefix = /^([a-z0-9_-]+):\/(.*)$/s.exec(text)
  const registered = prefix ? activeRoots(registry).find((root) => root.alias === prefix[1]) : undefined
  let candidate: string
  let selected: Root | undefined
  if (registered && prefix) {
    const relative = prefix[2]!
    if (relative.startsWith("/") || /^[a-z]:/i.test(relative)) fail("INVALID_PATH", "Alias paths must contain a relative suffix")
    candidate = absolute(relative || ".", registered.path)
    if (!inside(registered.path, candidate)) fail("OUTSIDE_ROOT", "An alias path cannot escape its registered root")
    selected = registered
  } else {
    const value = expanded(raw)
    if (!path.isAbsolute(value)) fail("INVALID_PATH", "Use alias:/relative/file or an absolute path")
    candidate = absolute(value, context.directory)
    selected = activeRoots(registry).find((root) => inside(root.path, candidate))
  }
  if (!selected) fail("OUTSIDE_ROOT", "File is outside all roots of the active workspace")
  assertNotDenied(text)
  assertNotDenied(candidate)
  await confirmTraversal(raw, selected.path, candidate, context)
  const [root] = await checkedRoots(registry, context, selected.alias)
  const canonical = absolute(await fs.realpath(candidate), context.directory)
  assertNotDenied(canonical)
  if (!root || !inside(root.path, canonical)) fail("OUTSIDE_ROOT", "Symbolic link or junction points outside the selected root")
  return { file: canonical, root }
}

function clippedLine(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 2000)} … [line truncated]` : value
}

async function fallbackGrep(roots: Root[], pattern: string, include: Bun.Glob | undefined, context: ToolContext): Promise<{ matches: Match[]; truncated: boolean; engine: string }> {
  try {
    new RegExp(pattern, "u")
  } catch {
    return fail("INVALID_PATTERN", "Invalid JavaScript regular expression (ripgrep unavailable or rejected the pattern)")
  }
  const matches: Match[] = []
  let matcher: RegexMatcher | undefined
  try {
    for await (const file of walk(roots, context.abort)) {
      if ((include && !include.match(file.relative)) || file.size > READ_LIMIT) continue
      let content: string
      try {
        const result = await boundedRead(file.absolute, READ_LIMIT, context.abort)
        if (result.truncated) continue
        content = decode(result.bytes)
      } catch (error) {
        if (errorCode(error) === "ENOENT" || (error instanceof WorkspaceError && error.code === "BINARY_FILE")) continue
        throw error
      }
      matcher ??= new RegexMatcher(pattern)
      const hits = await matcher.match(content, GREP_LIMIT - matches.length + 1, context.abort)
      for (const hit of hits) {
        if (matches.length === GREP_LIMIT) return { matches, truncated: true, engine: "fs+regex" }
        matches.push({ file: file.file, line: hit.line, text: `${hit.text}${hit.clipped ? " … [line truncated]" : ""}` })
      }
    }
    return { matches, truncated: false, engine: "fs+regex" }
  } finally {
    await matcher?.close()
  }
}

async function setupWorkspaceManager(ctx: Plugin.Context) {
  const directory = ctx.location.directory
  const options = ctx.options
  const projectDirectory = absolute(await fs.realpath(directory), directory)
  const override = path.join(projectDirectory, ".opencode", "workspace.json")
  let registryFile = path.join(homedir(), ".config", "opencode", "workspace-manager", "workspaces.json")
  if (typeof options.registryPath === "string") {
    registryFile = absolute(options.registryPath, projectDirectory)
  } else {
    try {
      await fs.lstat(override)
      registryFile = override
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
  const store = new RegistryStore(await canonicalStoragePath(registryFile, projectDirectory), projectDirectory)
  const notifications = await ctx.rpc.register(WorkspaceNotifications, {})

  async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
    // A UI transport failure must not turn a committed registry mutation into a failure.
    try {
      await notifications.events.emit("toast", { message, variant })
    } catch {
      // Non-TUI clients need no toast.
    }
  }

  async function saved(registry: RegistryData, message: string): Promise<void> {
    await toast(`${message} — workspace saved. Active: ${registry.active ?? "(none)"}`, "success")
  }

  async function sessionDirectory(sessionID: NativeToolContext["sessionID"]): Promise<string> {
    const session = await ctx.session.get({ sessionID })
    const location = absolute(await fs.realpath(session.location.directory ?? directory), projectDirectory)
    if (pathKey(location) !== pathKey(projectDirectory)) fail("WORKSPACE_LOCATION_CHANGED", "Session location changed; refresh the available tools before using this workspace")
    return session.subpath ? absolute(session.subpath, location) : location
  }

  async function toolContext(native: NativeToolContext): Promise<ToolContext> {
    native.signal.throwIfAborted()
    return {
      sessionID: native.sessionID,
      agent: native.agent,
      messageID: native.messageID,
      id: native.id,
      directory: await sessionDirectory(native.sessionID),
      abort: native.signal,
      metadata: async ({ title, metadata }) => {
        await native.progress({ ...(title === undefined ? {} : { title }), ...metadata })
      },
      ask: (input) => ctx.permission.assert({
        sessionID: native.sessionID,
        agent: native.agent,
        source: { type: "tool", messageID: native.messageID, id: native.id },
        action: input.permission,
        resources: input.patterns,
        save: input.always,
        metadata: { ...input.metadata, workspaceManager: true },
      }),
    }
  }

  async function workspaceContext(): Promise<string> {
    try {
      return activeContext(await store.read())
    } catch {
      // A corrupt plugin registry must not break every generation or /compact.
      return "Workspace registry unavailable. Do not infer allowed roots from old mappings; workspace_list/workspace_status will report the error. Never bypass workspace security with another tool."
    }
  }

  async function run(context: ToolContext, action: () => Promise<unknown>): Promise<string> {
    context.abort.throwIfAborted()
    try {
      return JSON.stringify(await action(), null, 2)
    } catch (error) {
      if (context.abort.aborted) throw error
      let problem: WorkspaceError
      if (error instanceof WorkspaceError) problem = error
      else {
        const code = errorCode(error)
        const messages: Record<string, string> = {
          ENOENT: "File or directory does not exist",
          ENOTDIR: "A path component is not a directory",
          EISDIR: "Expected a file, but found a directory",
          EACCES: "Filesystem access denied",
          EPERM: "Filesystem operation is not permitted",
          ELOOP: "Symbolic link loop or unsupported link",
          EBUSY: "File is busy; retry shortly",
        }
        // In particular, do not swallow permission rejection/cancellation errors.
        if (!code || !Object.hasOwn(messages, code)) throw error
        problem = new WorkspaceError(code, messages[code]!)
      }
      await toast(problem.message, "error")
      return JSON.stringify({ error: { code: problem.code, message: problem.message } })
    }
  }

  async function grep(roots: Root[], pattern: string, include: Bun.Glob | undefined, context: ToolContext): Promise<unknown> {
    if (!pattern || pattern.length > 4096 || pattern.includes("\0")) fail("INVALID_PATTERN", "Regex must be 1–4096 characters, without NUL")
    const executable = options.ripgrep === false ? null : Bun.which("rg", { PATH: process.env.PATH ?? process.env.Path ?? "" })
    if (!executable) return fallbackGrep(roots, pattern, include, context)
    const command = executable
    const matches: Match[] = []
    let batch: FileEntry[] = []
    let characters = 0
    async function flush(): Promise<boolean> {
      if (!batch.length) return true
      context.abort.throwIfAborted()
      // Only hand rg already-filtered, canonical, <=200 KB regular files.
      const files = batch.map((entry) => entry.absolute)
      const result = await $`${command} --json --no-config --no-ignore --hidden --no-unicode --crlf --encoding utf-8 --color never --line-number --max-filesize ${String(READ_LIMIT)} --max-count ${String(GREP_LIMIT + 1)} --regexp ${pattern} -- ${files}`.cwd(projectDirectory).quiet().nothrow()
      context.abort.throwIfAborted()
      if (result.exitCode > 1) return false
      const known = new Map(batch.map((entry) => [pathKey(entry.absolute), entry]))
      for (const line of result.text().split("\n")) {
        if (!line) continue
        const event = JSON.parse(line) as {
          type: string
          data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
        }
        if (event.type !== "match") continue
        const data = event.data
        const file = data?.path?.text ? known.get(pathKey(data.path.text)) : undefined
        if (!file || data?.lines?.text === undefined || data.line_number === undefined) continue
        if (matches.length === GREP_LIMIT) return true
        matches.push({ file: file.file, line: data.line_number, text: clippedLine(data.lines.text.replace(/\r?\n$/, "")) })
      }
      batch = []
      characters = 0
      return true
    }
    for await (const file of walk(roots, context.abort)) {
      if ((include && !include.match(file.relative)) || file.size > READ_LIMIT) continue
      if (batch.length && (batch.length === 16 || characters + file.absolute.length > 16_000)) {
        if (!(await flush())) return fallbackGrep(roots, pattern, include, context)
        if (matches.length === GREP_LIMIT) return { matches, truncated: true, engine: "rg" }
      }
      batch.push(file)
      characters += file.absolute.length + 3
    }
    if (!(await flush())) return fallbackGrep(roots, pattern, include, context)
    return { matches, truncated: matches.length === GREP_LIMIT, engine: "rg" }
  }

  const tools = {
      workspace_create: workspaceTool({
        description: "Create an empty named virtual workspace and make it active. Does not change cwd/worktree.",
        args: { name: Name },
        execute: (args, context) => run(context, async () => {
          const { registry } = await store.mutate(context.abort, (registry) => {
            if (Object.hasOwn(registry.workspaces, args.name)) fail("WORKSPACE_EXISTS", "A workspace with that name already exists")
            registry.workspaces[args.name] = { name: args.name, createdAt: new Date().toISOString(), roots: [] }
            registry.active = args.name
          })
          await saved(registry, `Created ${JSON.stringify(args.name)}`)
          return { active: registry.active, workspace: workspace(registry, args.name) }
        }),
      }),

      workspace_switch: workspaceTool({
        description: "Activate a saved virtual workspace and return its roots; the live session directory is unchanged.",
        args: { name: Name },
        execute: (args, context) => run(context, async () => {
          const { registry } = await store.mutate(context.abort, (registry) => {
            workspace(registry, args.name)
            registry.active = args.name
          })
          await saved(registry, `Switched to ${JSON.stringify(args.name)}`)
          return { active: registry.active, roots: activeRoots(registry) }
        }),
      }),

      workspace_list: workspaceTool({
        description: "Return the full persistent workspace registry, including the active workspace.",
        args: {},
        execute: (_args, context) => run(context, () => store.read(context.abort)),
      }),

      workspace_add: workspaceTool({
        description: "Validate and add a local directory to a workspace. Expands ~ and $HOME, canonicalizes paths, and deduplicates roots.",
        args: { workspace: Name, path: z.string().min(1), alias: Alias.optional() },
        execute: (args, context) => run(context, async () => {
          workspace(await store.read(context.abort), args.workspace)
          const candidate = absolute(args.path, context.directory)
          assertNotDenied(expanded(args.path))
          await confirmTraversal(args.path, context.directory, candidate, context)
          const canonical = await canonicalDirectory(args.path, context.directory)
          await externalPermission(canonical, context)
          const { registry, result } = await store.mutate(context.abort, (registry) => {
            const current = workspace(registry, args.workspace)
            const collision = args.alias ? current.roots.find((root) => root.alias === args.alias) : undefined
            if (collision && pathKey(collision.path) !== pathKey(canonical)) fail("ALIAS_EXISTS", "That alias is already assigned to another path")
            const existing = current.roots.find((root) => pathKey(root.path) === pathKey(canonical))
            if (existing) return { root: existing, added: false }
            if (current.roots.length === 20) fail("ROOT_LIMIT", "A workspace may contain at most 20 roots")
            const stem = path.basename(canonical).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || (WINDOWS ? canonical[0]!.toLowerCase() : "root")
            let alias = args.alias ?? stem
            for (let suffix = 2; !args.alias && current.roots.some((root) => root.alias === alias); suffix++) alias = `${stem}-${suffix}`
            const root = WorkspaceRoot.parse({ alias, path: canonical })
            current.roots.push(root)
            return { root, added: true }
          })
          if (result.added) await saved(registry, `Added ${result.root.alias} -> ${result.root.path}`)
          return { ...result, active: registry.active, workspace: args.workspace, roots: workspace(registry, args.workspace).roots }
        }),
      }),

      workspace_remove: workspaceTool({
        description: "Remove a root by alias/absolute path, or omit aliasOrPath to remove the workspace. Never deletes folders or files.",
        args: { workspace: Name, aliasOrPath: z.string().min(1).optional() },
        execute: (args, context) => run(context, async () => {
          let target = args.aliasOrPath
          if (target !== undefined && !Alias.safeParse(target).success) {
            target = absolute(target, context.directory)
            await confirmTraversal(args.aliasOrPath!, context.directory, target, context)
            try {
              target = absolute(await fs.realpath(target), context.directory)
            } catch (error) {
              if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error
            }
          }
          const { registry } = await store.mutate(context.abort, (registry) => {
            const current = workspace(registry, args.workspace)
            if (target === undefined) {
              delete registry.workspaces[args.workspace]
              if (registry.active === args.workspace) registry.active = null
            } else {
              const index = current.roots.findIndex((root) => root.alias === target || pathKey(root.path) === pathKey(target!))
              if (index < 0) fail("UNKNOWN_ROOT", "No root with that alias or path exists in the workspace")
              current.roots.splice(index, 1)
            }
          })
          await saved(registry, target === undefined ? `Removed workspace ${JSON.stringify(args.workspace)}` : "Removed folder registration")
          return { active: registry.active, roots: activeRoots(registry), removed: target ?? args.workspace }
        }),
      }),

      workspace_read: workspaceTool({
        description: "Read a UTF-8 file in an active root using alias:/file or an absolute path. Sensitive paths are denied; output is limited to 200 KB.",
        args: { path: z.string().min(1) },
        execute: (args, context) => run(context, async () => {
          const resolved = await resolveRead(args.path, await store.read(context.abort), context)
          const result = await boundedRead(resolved.file, READ_LIMIT, context.abort)
          return { content: decode(result.bytes, result.truncated), truncated: result.truncated }
        }),
      }),

      workspace_glob: workspaceTool({
        description: "Find files only in active roots. Supports alias:/glob or alias + relative pattern. Honors nested .gitignore, skips links/secrets, newest first, limit 200.",
        args: { pattern: z.string().min(1), alias: Alias.optional() },
        execute: (args, context) => run(context, async () => {
          const scope = globScope(args.pattern, args.alias)
          const matcher = searchPattern(scope.pattern)
          const roots = await checkedRoots(await store.read(context.abort), context, scope.alias)
          const files: FileEntry[] = []
          let count = 0
          for await (const file of walk(roots, context.abort)) {
            if (!matcher.match(file.relative)) continue
            count++
            files.push(file)
            files.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file, "en"))
            if (files.length > GLOB_LIMIT) files.pop()
          }
          return { files: files.map((file) => file.file), truncated: count > GLOB_LIMIT }
        }),
      }),

      workspace_grep: workspaceTool({
        description: "Regex search active roots via Bun shell + rg, with fs/RegExp fallback. Optional alias/include glob. Honors .gitignore; skips secrets, links, binary and >200 KB files; limit 100 matching lines.",
        args: { pattern: z.string().min(1), alias: Alias.optional(), include: z.string().min(1).optional() },
        execute: (args, context) => run(context, async () => {
          const include = args.include === undefined ? undefined : searchPattern(args.include)
          const roots = await checkedRoots(await store.read(context.abort), context, args.alias)
          return grep(roots, args.pattern, include, context)
        }),
      }),

      workspace_status: workspaceTool({
        description: "Return active workspace, roots and unique visible fileCount. Useful after restart and compaction; count excludes ignored files, links and sensitive paths.",
        args: {},
        execute: (_args, context) => run(context, async () => {
          const registry = await store.read(context.abort)
          if (registry.active === null) return { active: null, roots: [], fileCount: 0 }
          const roots = await checkedRoots(registry, context)
          let fileCount = 0
          for await (const _file of walk(roots, context.abort)) fileCount++
          await context.metadata({ title: `Workspace: ${registry.active} (${roots.length} roots)`, metadata: { active: registry.active, roots, fileCount } })
          return { active: registry.active, roots, fileCount }
        }),
      }),

      workspace_browse: workspaceTool({
        description: "Folder-picker helper: list subdirectories only, never file contents. May browse outside active roots after external_directory approval. Does not register a root.",
        args: { path: z.string().min(1).optional() },
        execute: (args, context) => run(context, async () => {
          const raw = args.path ?? context.directory
          const candidate = absolute(raw, context.directory)
          assertNotDenied(expanded(raw))
          await confirmTraversal(raw, context.directory, candidate, context)
          const current = await canonicalDirectory(raw, context.directory)
          await externalPermission(current, context)
          const entries = await fs.readdir(current, { withFileTypes: true })
          const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !denied(slash(path.join(current, entry.name))))
            .sort((a, b) => a.name.localeCompare(b.name, "en"))
          const parent = slash(path.dirname(current))
          return {
            current,
            parent: pathKey(parent) === pathKey(current) || denied(parent) ? null : parent,
            directories: directories.slice(0, BROWSE_LIMIT).map((entry) => ({ name: entry.name, path: slash(path.join(current, entry.name)) })),
            truncated: directories.length > BROWSE_LIMIT,
          }
        }),
      }),
  }

  await ctx.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(tools)) {
      editor.add({
        name,
        description: definition.description,
        input: definition.input,
        options: { codemode: false },
        execute: async (input, context) => ({ content: await definition.execute(input, await toolContext(context)) }),
      })
    }
  })

  // Force a real registry replay during startup, not just a successful import.
  const registered = new Set((await ctx.tool.list()).map((entry) => entry.id))
  const missing = Object.keys(tools).filter((name) => !registered.has(name))
  if (missing.length) throw new Error(`Workspace tools were not registered: ${missing.join(", ")}`)

  await ctx.tool.hook("execute.before", async (event) => {
    // Guard obvious built-in file access, without pretending to sandbox shell/MCP.
    if (event.tool.startsWith("workspace_")) return
    if (!["read", "glob", "grep", "list", "edit", "write", "patch"].includes(event.tool)) return
    const args: unknown = event.input
    if (!args || typeof args !== "object") return
    const values = args as Record<string, unknown>
    const raw = [values.filePath, values.path, values.directory].find((value): value is string => typeof value === "string")
    const registry = await store.read()
    const alias = raw ? /^([a-z0-9_-]+):\//.exec(slash(raw)) : null
    if (alias && activeRoots(registry).some((root) => root.alias === alias[1])) {
      fail("USE_WORKSPACE_TOOLS", "alias:/ paths belong to workspace_read, workspace_glob and workspace_grep, not built-in tools")
    }
    if (raw) assertNotDenied(expanded(raw))
    const current = await sessionDirectory(event.sessionID)
    const candidate = absolute(raw ?? current, current)
    assertNotDenied(candidate)
    let canonical = candidate
    try {
      canonical = absolute(await fs.realpath(candidate), current)
      assertNotDenied(canonical)
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error
    }
    if (["read", "glob", "grep", "list"].includes(event.tool) && activeRoots(registry).some((root) => inside(root.path, candidate) || inside(root.path, canonical))) {
      fail("USE_WORKSPACE_TOOLS", "Use workspace_read/workspace_glob/workspace_grep for active roots so workspace security and limits apply")
    }
  })

  await ctx.session.hook("context", async (event) => {
    event.system.push({ type: "text", text: await workspaceContext() })
  })

  await ctx.session.hook("compaction", async (event) => {
    const text = `${await workspaceContext()}\nPreserve this workspace mapping in the continuation summary. Refresh it with workspace_status after compaction.`
    event.system.push({ type: "text", text })
    if (event.result !== undefined) event.result = { ...event.result, summary: `${event.result.summary}\n\n${text}` }
  })

  await ctx.permission.hook("evaluate", async (event) => {
    if (event.effect === "deny") return
    // Escalate our traversal checks, never a configured deny or a user's ask.
    if (event.action === "workspace_escape" && event.metadata?.workspaceManager === true) {
      event.effect = "ask"
      event.message = [event.message, "Confirm this workspace path containing parent-directory traversal."].filter(Boolean).join("\n")
      return
    }
    if (event.action !== "external_directory" || event.effect !== "ask") return
    try {
      const patterns = event.resources
      const roots = activeRoots(await store.read())
      if (!patterns.length || !roots.length) return
      for (const pattern of patterns) {
        const raw = slash(pattern).replace(/\/\*\*?\/?$/, "/")
        if (/[?*]/.test(raw)) return
        const candidate = absolute(raw, directory)
        if (denied(candidate) || !roots.some((root) => inside(root.path, candidate))) return
        const canonical = absolute(await fs.realpath(candidate), directory)
        if (denied(canonical) || !roots.some((root) => inside(root.path, canonical))) return
      }
      event.message = [event.message, "Requested paths are inside active workspace roots. You may allow this request if intended; approval remains your choice."].filter(Boolean).join("\n")
    } catch {
      // Unavailable paths must not receive an approval suggestion.
    }
  })
}

export default Plugin.define({
  id: "workspace-manager",
  setup: setupWorkspaceManager,
})
