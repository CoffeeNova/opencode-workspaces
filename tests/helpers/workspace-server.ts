import { Database } from "bun:sqlite"
import type { Plugin } from "@opencode/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import * as fs from "node:fs/promises"
import path from "node:path"
import Server from "../../src/index.ts"
import { Selection, State, type Action, type Change } from "../../src/shared/schemas.ts"
import { Catalog } from "../../src/server/catalog/catalog.ts"
import { slash } from "../../src/server/filesystem/paths.ts"
import { WorkspaceRPC } from "../../src/rpc.ts"
import type { Fake } from "./fake.ts"
import { createTempBase } from "./filesystem-fixture.ts"

type Hook<Event> = (event: Event) => void | Promise<void>
type Before = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id"> & {
  tool: string
  input: unknown
}
type Handlers = RpcHandlers<typeof WorkspaceRPC>
type PermissionInput = Parameters<Plugin.Context["permission"]["assert"]>[0]
type TestSession = { directory: string; history: unknown[] }

type Paths = {
  base: string
  directory: string
  root: string
  catalogPath: string
}

// Everything the fake host records or lets a test steer.
type HostState = {
  sessions: Map<string, TestSession>
  tools: Map<string, Info>
  sessionHooks: Map<string, Hook<SessionCompaction>>
  toolHooks: Map<string, Hook<Before>>
  permissionHooks: Map<string, Hook<PermissionEvaluation>>
  permissions: PermissionInput[]
  events: unknown[]
  handlers: Handlers | undefined
  modelCalls: number
  contextLimit: number
  permissionError: Error | undefined
  eventError: Error | undefined
}

async function createPaths(): Promise<Paths> {
  const base = await createTempBase("workspace-server-test-")
  const directory = slash(path.join(base, "launch"))
  const root = slash(path.join(base, "external docs"))
  const catalogPath = path.join(base, "catalog", "workspaces.sqlite")
  await Promise.all([directory, root].map((value) => fs.mkdir(value)))
  return { base, directory, root, catalogPath }
}

function createState(): HostState {
  return {
    sessions: new Map(),
    tools: new Map(),
    sessionHooks: new Map(),
    toolHooks: new Map(),
    permissionHooks: new Map(),
    permissions: [],
    events: [],
    handlers: undefined,
    modelCalls: 0,
    contextLimit: 128_000,
    permissionError: undefined,
    eventError: undefined,
  }
}

function addSession(state: HostState, directory: string, id: string, location = directory) {
  state.sessions.set(id, { directory: location, history: [] })
  return id
}

function getSession(state: HostState, id: string) {
  const session = state.sessions.get(id)
  if (!session) throw new Error(`Unexpected test session ${id}`)
  return session
}

const registration = () => ({ dispose: async () => {} })

function sessionApi(state: HostState) {
  return {
    get: async ({ sessionID }: { sessionID: string }) => ({
      location: { directory: getSession(state, sessionID).directory },
    }),
    context: async ({ sessionID }: { sessionID: string }) => getSession(state, sessionID).history,
    hook: async (name: string, hook: Hook<SessionCompaction>) => {
      state.sessionHooks.set(name, hook)
      return registration()
    },
  }
}

function rpcApi(state: HostState) {
  return {
    register: async (_definition: typeof WorkspaceRPC, value: Handlers) => {
      state.handlers = value
      return { ...registration(), events: { emit: emitEvent(state) } }
    },
  }
}

function emitEvent(state: HostState) {
  return async (...args: unknown[]) => {
    if (state.eventError) throw state.eventError
    state.events.push(args)
  }
}

function toolApi(state: HostState) {
  return {
    transform: async (transform: (editor: { add(tool: Info): void }) => void) => {
      const add = (tool: Info) => {
        state.tools.set(tool.name, tool)
      }
      transform({ add })
      return registration()
    },
    hook: async (name: string, hook: Hook<Before>) => {
      state.toolHooks.set(name, hook)
      return registration()
    },
  }
}

function permissionApi(state: HostState) {
  return {
    assert: async (input: PermissionInput) => {
      state.permissions.push(input)
      if (state.permissionError) throw state.permissionError
    },
    hook: async (name: string, hook: Hook<PermissionEvaluation>) => {
      state.permissionHooks.set(name, hook)
      return registration()
    },
  }
}

function modelApi(state: HostState) {
  return {
    list: async () => {
      state.modelCalls++
      const limit = { context: state.contextLimit }
      return { data: [{ providerID: "fixture", id: "large", limit }] }
    },
  }
}

// The plugin context the server sees: only the members the tests exercise.
function createFakeHost(state: HostState, paths: Paths, configured: boolean): Plugin.Context {
  const options = configured ? { catalogPath: paths.catalogPath } : {}
  return {
    location: { directory: paths.directory },
    options,
    session: sessionApi(state),
    rpc: rpcApi(state),
    tool: toolApi(state),
    permission: permissionApi(state),
    model: modelApi(state),
  } satisfies Fake<Plugin.Context> as unknown as Plugin.Context
}

function registeredHandlers(state: HostState) {
  if (!state.handlers) throw new Error("Workspace RPC was not registered")
  return state.handlers
}

function createCall(signal = new AbortController().signal): Parameters<Handlers["state"]>[1] {
  return {
    signal,
    error(...args): never {
      const [, message, data] = args
      throw Object.assign(new Error(message), data)
    },
  }
}

// Calls the registered RPC handlers and validates every reply against the schemas.
function createRpcClient(state: HostState) {
  return {
    state: async (input: { sessionID?: string } = {}, signal?: AbortSignal) =>
      State.parse(await registeredHandlers(state).state(input, createCall(signal))),
    selection: async (input: { sessionID: string }) =>
      Selection.parse(await registeredHandlers(state).selection(input, createCall())),
    change: async (input: Change, signal?: AbortSignal) =>
      State.parse(await registeredHandlers(state).change(input, createCall(signal))),
    browse: async (input: { path?: string }) =>
      registeredHandlers(state).browse(input, createCall()),
  }
}

function createRequest(state: HostState, sessionID = "ses_a"): SessionContext {
  const toolNames = ["read", "shell", "other_plugin", ...state.tools.keys()]
  const tools = Object.fromEntries(
    toolNames.map((name) => [name, { description: name, input: { type: "object" } }]),
  )
  return {
    sessionID: sessionID as SessionContext["sessionID"],
    agent: "build" as SessionContext["agent"],
    model: { providerID: "fixture", id: "large" } as SessionContext["model"],
    system: [{ type: "text", text: "Native project/global instructions" }],
    messages: [],
    options: {},
    tools,
  }
}

function createToolContext(sessionID = "ses_a"): ToolContext {
  return {
    sessionID: sessionID as ToolContext["sessionID"],
    agent: "build" as ToolContext["agent"],
    messageID: "msg_unit" as ToolContext["messageID"],
    id: "call_unit" as ToolContext["id"],
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

function countBindings(catalogPath: string) {
  const db = new Database(catalogPath, { readonly: true })
  try {
    return db.query<{ count: number }, []>("SELECT count(*) AS count FROM bindings").get()!.count
  } finally {
    db.close()
  }
}

async function seedCatalog(paths: Paths, name: string) {
  const catalog = await Catalog.open(paths.catalogPath, paths.directory)
  try {
    const change = {
      requestID: crypto.randomUUID(),
      expectedRevision: catalog.state().revision,
      action: { kind: "create", name },
    } satisfies Change
    return catalog.change(change, paths.directory, false)
  } finally {
    catalog.close()
  }
}

export async function workspaceServer(configured = true) {
  const paths = await createPaths()
  const { base, directory, root, catalogPath } = paths
  const state = createState()
  for (const id of ["ses_a", "ses_b", "ses_child"]) addSession(state, directory, id)
  const host = createFakeHost(state, paths, configured)
  const rpc = createRpcClient(state)
  let cleanup: Awaited<ReturnType<typeof Server.setup>>
  async function start() {
    cleanup = await Server.setup(host)
  }
  async function stop() {
    if (typeof cleanup === "function") await cleanup()
  }
  try {
    await start()
  } catch (error) {
    await fs.rm(base, { recursive: true, force: true })
    throw error
  }
  return {
    base,
    directory,
    root,
    catalogPath,
    sessions: state.sessions,
    addSession: (id: string, location = directory) => addSession(state, directory, id, location),
    tools: state.tools,
    permissions: state.permissions,
    events: state.events,
    rpc,
    request: (sessionID = "ses_a") => createRequest(state, sessionID),
    toolContext: createToolContext,
    get modelCalls() {
      return state.modelCalls
    },
    setContextLimit(value: number) {
      state.contextLimit = value
    },
    denyPermission(error: Error) {
      state.permissionError = error
    },
    failEvents(error: Error) {
      state.eventError = error
    },
    async context(event: SessionContext) {
      await state.sessionHooks.get("context")!(event)
    },
    compact(event: SessionCompaction) {
      return state.sessionHooks.get("compaction")!(event)
    },
    async before(tool: string, input: unknown, sessionID = "ses_a") {
      const context = createToolContext(sessionID)
      await state.toolHooks.get("execute.before")!({ ...context, tool, input })
    },
    async evaluate(event: PermissionEvaluation) {
      await state.permissionHooks.get("evaluate")!(event)
      return event
    },
    async execute(name: string, input: Record<string, unknown> = {}, sessionID = "ses_a") {
      const tool = state.tools.get(name)
      if (!tool) throw new Error(`Unexpected test tool ${name}`)
      return tool.execute(input, createToolContext(sessionID))
    },
    async change(action: Action, sessionID?: string) {
      const { revision } = await rpc.state()
      return rpc.change({
        requestID: crypto.randomUUID(),
        expectedRevision: revision,
        ...(sessionID ? { sessionID } : {}),
        action,
      })
    },
    seed: (name = "alpha") => seedCatalog(paths, name),
    bindingCount: () => countBindings(catalogPath),
    async reload() {
      await stop()
      await start()
    },
    async dispose() {
      await stop()
      await fs.rm(base, { recursive: true, force: true })
    },
  }
}
