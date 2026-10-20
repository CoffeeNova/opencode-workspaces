import type { Context } from "@opencode/plugin/tui/plugin"
import type {
  DialogAlertOptions,
  DialogConfirmOptions,
  DialogPromptOptions,
  DialogSelectOptions,
  KeymapLayer,
  Route,
  ToastOptions,
} from "@opencode/plugin/tui/context"
import { type Change } from "../../src/shared/schemas.ts"
import { WorkspaceRPC } from "../../src/rpc.ts"
import Tui from "../../src/tui/plugin.ts"
import { workspaceServer } from "./workspace-server.ts"
import type { Fake } from "./fake.ts"

type Options = { location: { directory: string }; signal: AbortSignal }
type Answer =
  | string
  | undefined
  | Promise<string | undefined>
  | ((options: DialogSelectOptions<string>) => string | undefined | Promise<string | undefined>)
type Name = string | ((options: DialogPromptOptions) => string | undefined)
// Every dialog and toast the menu shows, in call order, with the options it passed.
export type DialogCall =
  | { kind: "select"; options: DialogSelectOptions<string> }
  | { kind: "prompt"; options: DialogPromptOptions }
  | { kind: "confirm"; options: DialogConfirmOptions }
  | { kind: "alert"; options: DialogAlertOptions }
  | { kind: "toast"; options: ToastOptions }

type Server = Awaited<ReturnType<typeof workspaceServer>>

// What a test scripts: the answers the fake dialogs hand back, in order.
type Script = {
  answers: Answer[]
  names: Name[]
  confirmations: (boolean | undefined)[]
}

// What the fake host records and the switches a test can flip.
type Recording = {
  selections: DialogSelectOptions<string>[]
  alerts: { title: string; message: string }[]
  transcript: DialogCall[]
  calls: { method: string; input: unknown; options: Options }[]
  created: { id: string; input: unknown }[]
  navigations: Route[]
  forbidden: string[]
  slots: string[]
}

type Behavior = {
  current: Route
  cached: boolean
  layer: KeymapLayer | undefined
  unregistered: number
  holdAttach: (() => Promise<void>) | undefined
}

type HostState = { script: Script; recording: Recording; behavior: Behavior }

function createState(initial: Route): HostState {
  return {
    script: { answers: [], names: [], confirmations: [] },
    recording: {
      selections: [],
      alerts: [],
      transcript: [],
      calls: [],
      created: [],
      navigations: [],
      forbidden: [],
      slots: [],
    },
    behavior: {
      current: initial,
      cached: true,
      layer: undefined,
      unregistered: 0,
      holdAttach: undefined,
    },
  }
}

// The workspace RPC as the TUI sees it: every call is recorded, then served by the server fake.
function createRpc(server: Server, state: HostState) {
  const record = (method: string, input: unknown, options: Options) => {
    state.recording.calls.push({ method, input, options })
  }
  return {
    state: (input: { sessionID?: string }, options: Options) => {
      record("state", input, options)
      return server.rpc.state(input, options.signal)
    },
    selection: (input: { sessionID: string }, options: Options) => {
      record("selection", input, options)
      return server.rpc.selection(input)
    },
    change: async (input: Change, options: Options) => {
      record("change", input, options)
      const result = await server.rpc.change(input, options.signal)
      if (input.action.kind === "attach") await state.behavior.holdAttach?.()
      return result
    },
    browse: (input: { path?: string }, options: Options) => {
      record("browse", input, options)
      return server.rpc.browse(input)
    },
  }
}

// The TUI may only use rpc() and session.create(); any other client member is a test failure.
function createClient(server: Server, state: HostState, rpc: ReturnType<typeof createRpc>) {
  const allowed = {
    rpc: (definition: typeof WorkspaceRPC) => {
      if (definition !== WorkspaceRPC) throw new Error("Unexpected RPC definition")
      return rpc
    },
    session: {
      create: async (input: unknown) => {
        const { created } = state.recording
        const id = server.addSession(`ses_created_${created.length + 1}`)
        created.push({ id, input })
        return { id }
      },
    },
  }
  return new Proxy(allowed, {
    get(target, key) {
      if (key === "rpc") return target.rpc
      if (key === "session") return target.session
      state.recording.forbidden.push(String(key))
      throw new Error(`Unexpected TUI client operation ${String(key)}`)
    },
  })
}

function createDialogs(state: HostState) {
  const { script, recording } = state
  return {
    select: async (options: DialogSelectOptions<string>) => {
      recording.transcript.push({ kind: "select", options })
      recording.selections.push(options)
      if (!script.answers.length) throw new Error(`Unexpected selection dialog: ${options.title}`)
      const answer = script.answers.shift()
      return typeof answer === "function" ? answer(options) : answer
    },
    prompt: async (options: DialogPromptOptions) => {
      recording.transcript.push({ kind: "prompt", options })
      if (!script.names.length) throw new Error("Unexpected name prompt")
      const name = script.names.shift()
      return typeof name === "function" ? name(options) : name
    },
    confirm: async (options: DialogConfirmOptions) => {
      recording.transcript.push({ kind: "confirm", options })
      if (!script.confirmations.length) {
        throw new Error(`Unexpected confirmation dialog: ${options.title}`)
      }
      return script.confirmations.shift()
    },
    alert: async (input: DialogAlertOptions) => {
      recording.transcript.push({ kind: "alert", options: input })
      recording.alerts.push(input)
    },
  }
}

function createRouter(state: HostState) {
  const { behavior, recording } = state
  return {
    current: () => behavior.current,
    navigate: (route: Route) => {
      recording.navigations.push(route)
      behavior.current = route
    },
  }
}

function createUi(state: HostState) {
  const { behavior, recording } = state
  return {
    router: createRouter(state),
    slot: (input: { append: string }) => {
      recording.slots.push(input.append)
      return () => {
        behavior.unregistered++
      }
    },
    toast: {
      show: (options: ToastOptions) => {
        recording.transcript.push({ kind: "toast", options })
      },
    },
    dialog: createDialogs(state),
  }
}

function createData(server: Server, state: HostState) {
  return {
    location: { default: () => ({ directory: server.directory }) },
    session: {
      get: (id: string) => {
        if (!state.behavior.cached) return undefined
        const session = server.sessions.get(id)
        return session ? { location: { directory: session.directory } } : undefined
      },
    },
  }
}

function createContext(server: Server, state: HostState): Context {
  const client = createClient(server, state, createRpc(server, state))
  const keymap = {
    layer: (factory: () => KeymapLayer) => {
      state.behavior.layer = factory()
    },
  }
  return {
    location: { directory: server.directory },
    client,
    data: createData(server, state),
    keymap,
    ui: createUi(state),
  } satisfies Fake<Context> as unknown as Context
}

// Starts the TUI plugin against the fake host and returns its command layer and cleanup.
async function setUpTui(server: Server, state: HostState) {
  const context = createContext(server, state)
  let initialized: Awaited<ReturnType<typeof Tui.setup>>
  try {
    initialized = await Tui.setup(context)
  } catch (error) {
    await server.dispose()
    throw error
  }
  const commands = state.behavior.layer?.commands
  if (!commands || typeof initialized !== "function") {
    await server.dispose()
    throw new Error("Workspace TUI did not register commands/cleanup")
  }
  return { commands, cleanup: initialized }
}

export async function tuiHost(initial: Route = { type: "session", sessionID: "ses_a" }) {
  const server = await workspaceServer()
  const state = createState(initial)
  const { behavior, recording, script } = state
  const { commands, cleanup } = await setUpTui(server, state)
  let unloaded = false
  const unload = () => {
    if (unloaded) return
    unloaded = true
    cleanup()
  }
  return {
    server,
    answers: script.answers,
    names: script.names,
    confirmations: script.confirmations,
    selections: recording.selections,
    alerts: recording.alerts,
    transcript: recording.transcript,
    calls: recording.calls,
    created: recording.created,
    navigations: recording.navigations,
    forbidden: recording.forbidden,
    slots: recording.slots,
    commands,
    unload,
    get unregistered() {
      return behavior.unregistered
    },
    route(value: Route) {
      behavior.current = value
    },
    cached(value: boolean) {
      behavior.cached = value
    },
    holdAttach(value: () => Promise<void>) {
      behavior.holdAttach = value
    },
    async run(name = "workspace") {
      const command = commands.find((command) => command.slash?.name === name)
      if (!command) throw new Error(`Missing slash command ${name}`)
      await command.run()
    },
    async dispose() {
      unload()
      await server.dispose()
    },
  }
}
