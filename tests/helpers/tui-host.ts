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
import Tui from "../../src/tui.ts"
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

export async function tuiHost(initial: Route = { type: "session", sessionID: "ses_a" }) {
  const server = await workspaceServer()
  const answers: Answer[] = []
  const names: Name[] = []
  const confirmations: (boolean | undefined)[] = []
  const selections: DialogSelectOptions<string>[] = []
  const alerts: { title: string; message: string }[] = []
  const transcript: DialogCall[] = []
  const calls: { method: string; input: unknown; options: Options }[] = []
  const created: { id: string; input: unknown }[] = []
  const navigations: Route[] = []
  const forbidden: string[] = []
  const slots: string[] = []
  let current = initial
  let cached = true
  let layer: KeymapLayer | undefined
  let unregistered = 0
  let holdAttach: (() => Promise<void>) | undefined
  const record = (method: string, input: unknown, options: Options) => {
    calls.push({ method, input, options })
  }
  const rpc = {
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
      const state = await server.rpc.change(input, options.signal)
      if (input.action.kind === "attach") await holdAttach?.()
      return state
    },
    browse: (input: { path?: string }, options: Options) => {
      record("browse", input, options)
      return server.rpc.browse(input)
    },
  }
  const client = new Proxy(
    {
      rpc: (definition: typeof WorkspaceRPC) => {
        if (definition !== WorkspaceRPC) throw new Error("Unexpected RPC definition")
        return rpc
      },
      session: {
        create: async (input: unknown) => {
          const id = server.addSession(`ses_created_${created.length + 1}`)
          created.push({ id, input })
          return { id }
        },
      },
    },
    {
      get(target, key) {
        if (key === "rpc") return target.rpc
        if (key === "session") return target.session
        forbidden.push(String(key))
        throw new Error(`Unexpected TUI client operation ${String(key)}`)
      },
    },
  )
  const context = {
    location: { directory: server.directory },
    client,
    data: {
      location: { default: () => ({ directory: server.directory }) },
      session: {
        get: (id: string) =>
          cached && server.sessions.has(id)
            ? { location: { directory: server.sessions.get(id)!.directory } }
            : undefined,
      },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        layer = factory()
      },
    },
    ui: {
      router: {
        current: () => current,
        navigate: (route: Route) => {
          navigations.push(route)
          current = route
        },
      },
      slot: (input: { append: string }) => {
        slots.push(input.append)
        return () => {
          unregistered++
        }
      },
      toast: {
        show: (options: ToastOptions) => {
          transcript.push({ kind: "toast", options })
        },
      },
      dialog: {
        select: async (options: DialogSelectOptions<string>) => {
          transcript.push({ kind: "select", options })
          selections.push(options)
          if (!answers.length) throw new Error(`Unexpected selection dialog: ${options.title}`)
          const answer = answers.shift()
          return typeof answer === "function" ? answer(options) : answer
        },
        prompt: async (options: DialogPromptOptions) => {
          transcript.push({ kind: "prompt", options })
          if (!names.length) throw new Error("Unexpected name prompt")
          const name = names.shift()
          return typeof name === "function" ? name(options) : name
        },
        confirm: async (options: DialogConfirmOptions) => {
          transcript.push({ kind: "confirm", options })
          if (!confirmations.length) {
            throw new Error(`Unexpected confirmation dialog: ${options.title}`)
          }
          return confirmations.shift()
        },
        alert: async (input: DialogAlertOptions) => {
          transcript.push({ kind: "alert", options: input })
          alerts.push(input)
        },
      },
    },
  } satisfies Fake<Context> as unknown as Context
  let initialized: Awaited<ReturnType<typeof Tui.setup>>
  try {
    initialized = await Tui.setup(context)
  } catch (error) {
    await server.dispose()
    throw error
  }
  if (!layer?.commands || typeof initialized !== "function") {
    await server.dispose()
    throw new Error("Workspace TUI did not register commands/cleanup")
  }
  const cleanup = initialized
  const commands = layer.commands
  let unloaded = false
  const unload = () => {
    if (!unloaded) {
      unloaded = true
      cleanup()
    }
  }
  return {
    server,
    answers,
    names,
    confirmations,
    selections,
    alerts,
    transcript,
    calls,
    created,
    navigations,
    forbidden,
    slots,
    commands,
    unload,
    get unregistered() {
      return unregistered
    },
    route(value: Route) {
      current = value
    },
    cached(value: boolean) {
      cached = value
    },
    holdAttach(value: () => Promise<void>) {
      holdAttach = value
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
