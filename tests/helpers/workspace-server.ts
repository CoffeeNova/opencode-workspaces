import { Database } from "bun:sqlite"
import type { Plugin } from "@opencode/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import Server from "../../src/index.ts"
import { Selection, State, type Action, type Change } from "../../src/domain.ts"
import { Catalog } from "../../src/infrastructure/catalog.ts"
import { slash } from "../../src/infrastructure/paths.ts"
import { WorkspaceRPC } from "../../src/rpc.ts"
import type { Fake } from "./fake.ts"

type Hook<Event> = (event: Event) => void | Promise<void>
type Before = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id"> & {
  tool: string
  input: unknown
}

export async function workspaceServer(configured = true) {
  const parent = path.join(tmpdir(), "opencode")
  await fs.mkdir(parent, { recursive: true })
  const base = await fs.realpath(await fs.mkdtemp(path.join(parent, "workspace-server-test-")))
  const directory = slash(path.join(base, "launch"))
  const root = slash(path.join(base, "external docs"))
  const catalogPath = path.join(base, "catalog", "workspaces.sqlite")
  await Promise.all([directory, root].map((value) => fs.mkdir(value)))
  const sessions = new Map<string, { directory: string; history: unknown[] }>()
  const addSession = (id: string, location = directory) => {
    sessions.set(id, { directory: location, history: [] })
    return id
  }
  for (const id of ["ses_a", "ses_b", "ses_child"]) addSession(id)
  const getSession = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new Error(`Unexpected test session ${id}`)
    return session
  }
  const tools = new Map<string, Info>()
  const sessionHooks = new Map<string, Hook<SessionCompaction>>()
  const toolHooks = new Map<string, Hook<Before>>()
  const permissionHooks = new Map<string, Hook<PermissionEvaluation>>()
  const permissions: Parameters<Plugin.Context["permission"]["assert"]>[0][] = []
  const events: unknown[] = []
  let handlers: RpcHandlers<typeof WorkspaceRPC> | undefined
  let cleanup: Awaited<ReturnType<typeof Server.setup>>
  let modelCalls = 0
  let contextLimit = 128_000
  let permissionError: Error | undefined
  const registration = () => ({ dispose: async () => {} })
  const context = {
    location: { directory },
    options: configured ? { catalogPath } : {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: getSession(sessionID).directory },
      }),
      context: async ({ sessionID }: { sessionID: string }) => getSession(sessionID).history,
      hook: async (name: string, hook: Hook<SessionCompaction>) => {
        sessionHooks.set(name, hook)
        return registration()
      },
    },
    rpc: {
      register: async (
        _definition: typeof WorkspaceRPC,
        value: RpcHandlers<typeof WorkspaceRPC>,
      ) => {
        handlers = value
        return {
          ...registration(),
          events: {
            emit: async (...args: unknown[]) => {
              events.push(args)
            },
          },
        }
      },
    },
    tool: {
      transform: async (transform: (editor: { add(tool: Info): void }) => void) => {
        transform({
          add: (tool) => {
            tools.set(tool.name, tool)
          },
        })
        return registration()
      },
      hook: async (name: string, hook: Hook<Before>) => {
        toolHooks.set(name, hook)
        return registration()
      },
    },
    permission: {
      assert: async (input: Parameters<Plugin.Context["permission"]["assert"]>[0]) => {
        permissions.push(input)
        if (permissionError) throw permissionError
      },
      hook: async (name: string, hook: Hook<PermissionEvaluation>) => {
        permissionHooks.set(name, hook)
        return registration()
      },
    },
    model: {
      list: async () => {
        modelCalls++
        return { data: [{ providerID: "fixture", id: "large", limit: { context: contextLimit } }] }
      },
    },
  } satisfies Fake<Plugin.Context> as unknown as Plugin.Context
  function registered() {
    if (!handlers) throw new Error("Workspace RPC was not registered")
    return handlers
  }
  const call = (
    signal = new AbortController().signal,
  ): Parameters<RpcHandlers<typeof WorkspaceRPC>["state"]>[1] => ({
    signal,
    error(...args): never {
      const [, message, data] = args
      throw Object.assign(new Error(message), data)
    },
  })
  const rpc = {
    state: async (input: { sessionID?: string } = {}, signal?: AbortSignal) =>
      State.parse(await registered().state(input, call(signal))),
    selection: async (input: { sessionID: string }) =>
      Selection.parse(await registered().selection(input, call())),
    change: async (input: Change, signal?: AbortSignal) =>
      State.parse(await registered().change(input, call(signal))),
    browse: async (input: { path?: string }) => registered().browse(input, call()),
  }
  function request(sessionID = "ses_a"): SessionContext {
    return {
      sessionID: sessionID as SessionContext["sessionID"],
      agent: "build" as SessionContext["agent"],
      model: { providerID: "fixture", id: "large" } as SessionContext["model"],
      system: [{ type: "text", text: "Native project/global instructions" }],
      messages: [],
      options: {},
      tools: Object.fromEntries(
        ["read", "shell", "other_plugin", ...tools.keys()].map((name) => [
          name,
          { description: name, input: { type: "object" } },
        ]),
      ),
    }
  }
  function toolContext(sessionID = "ses_a"): ToolContext {
    return {
      sessionID: sessionID as ToolContext["sessionID"],
      agent: "build" as ToolContext["agent"],
      messageID: "msg_unit" as ToolContext["messageID"],
      id: "call_unit" as ToolContext["id"],
      signal: new AbortController().signal,
      progress: async () => {},
    }
  }
  async function start() {
    cleanup = await Server.setup(context)
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
    sessions,
    addSession,
    tools,
    permissions,
    events,
    rpc,
    request,
    toolContext,
    get modelCalls() {
      return modelCalls
    },
    setContextLimit(value: number) {
      contextLimit = value
    },
    denyPermission(error: Error) {
      permissionError = error
    },
    async context(event: SessionContext) {
      await sessionHooks.get("context")!(event)
    },
    compact(event: SessionCompaction) {
      return sessionHooks.get("compaction")!(event)
    },
    async before(tool: string, input: unknown, sessionID = "ses_a") {
      await toolHooks.get("execute.before")!({ ...toolContext(sessionID), tool, input })
    },
    async evaluate(event: PermissionEvaluation) {
      await permissionHooks.get("evaluate")!(event)
      return event
    },
    async execute(name: string, input: Record<string, unknown> = {}, sessionID = "ses_a") {
      const tool = tools.get(name)
      if (!tool) throw new Error(`Unexpected test tool ${name}`)
      return tool.execute(input, toolContext(sessionID))
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
    async seed(name = "alpha") {
      const catalog = await Catalog.open(catalogPath, directory)
      try {
        return catalog.change(
          {
            requestID: crypto.randomUUID(),
            expectedRevision: catalog.state().revision,
            action: { kind: "create", name },
          },
          directory,
          false,
        )
      } finally {
        catalog.close()
      }
    },
    bindingCount() {
      const db = new Database(catalogPath, { readonly: true })
      try {
        return db.query<{ count: number }, []>("SELECT count(*) AS count FROM bindings").get()!
          .count
      } finally {
        db.close()
      }
    },
    async reload() {
      if (typeof cleanup === "function") await cleanup()
      await start()
    },
    async dispose() {
      if (typeof cleanup === "function") await cleanup()
      await fs.rm(base, { recursive: true, force: true })
    },
  }
}
