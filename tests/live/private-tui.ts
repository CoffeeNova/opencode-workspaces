import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { slash, type LiveFixture, type LiveHost } from "./fixture.ts"
import { terminalScreen } from "./terminal-screen.ts"

export type PrivateTui = Awaited<ReturnType<typeof openPrivateTui>>

const COLUMNS = 110
const ROWS = 32
const MAX_TRANSCRIPT_LENGTH = 16 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 10_000

type Snapshot = { label: string; view: string }

function messageText(data: unknown) {
  if (typeof data === "string") return data
  return new TextDecoder().decode(data as ArrayBuffer)
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

// Authenticated public PTY transport. Only the spawned fixture TUI is controlled.
export async function openPrivateTui(
  executable: string,
  fixture: LiveFixture,
  host: LiveHost,
  tag: string,
  sessionID?: string,
) {
  assert.match(tag, /^[a-z-]+$/)
  if (sessionID) await host.client.session.get({ sessionID }) // --session can otherwise create a session.
  const location = { directory: slash(fixture.launch) }
  const pty = await host.client.pty.create({
    location,
    command: executable,
    args: ["--server", host.url, ...(sessionID ? ["--session", sessionID] : [])],
    cwd: fixture.launch,
    env: { ...fixture.env, TERM: "xterm-256color" },
  })
  const ptyID = pty.data.id
  let socket: WebSocket | undefined
  let closing = false
  let output = ""
  const snapshots: Snapshot[] = []
  const screen = terminalScreen(COLUMNS, ROWS, (reply) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(reply)
  })

  async function writeArtifacts() {
    const transcriptName = tag === "home" ? "tui-output.ansi" : `tui-${tag}.ansi`
    await fs.writeFile(path.join(fixture.base, transcriptName), output)
    await fs.writeFile(
      path.join(fixture.base, `tui-${tag}-screens.json`),
      JSON.stringify(snapshots, null, 2),
    )
  }

  async function close() {
    if (closing) return
    closing = true
    snapshots.push({ label: "final viewport", view: screen.text() })
    socket?.close()
    try {
      await host.client.pty.remove({ location, ptyID })
    } finally {
      await screen.dispose()
      await writeArtifacts()
    }
  }

  async function connectUrl() {
    const token = await host.client.pty.connect.token({
      location,
      ptyID,
      "x-opencode-ticket": "1",
    })
    const url = new URL(`/api/pty/${ptyID}/connect`, host.url)
    url.protocol = "ws:"
    url.searchParams.set("location[directory]", location.directory)
    url.searchParams.set("ticket", token.data.ticket)
    return url
  }

  function receive(event: MessageEvent) {
    if (closing) return
    const text = messageText(event.data)
    // PTY protocol control frame: NUL + JSON cursor after replay, not VT text.
    if (text.startsWith("\0")) return
    output += text
    if (output.length > MAX_TRANSCRIPT_LENGTH) {
      screen.end(new Error("Disposable TUI transcript exceeded 16 MiB"))
      return
    }
    void screen.write(text).catch((error: unknown) => screen.end(toError(error)))
  }

  async function connect(url: URL) {
    const connection = new WebSocket(url)
    socket = connection
    connection.binaryType = "arraybuffer"
    const connected = Promise.withResolvers<void>()
    connection.addEventListener("open", () => connected.resolve())
    connection.addEventListener("error", () => {
      const error = new Error("Private PTY WebSocket failed")
      connected.reject(error)
      screen.end(error)
    })
    connection.addEventListener("close", () => {
      if (!closing) screen.end()
    })
    connection.addEventListener("message", receive)
    const timer = setTimeout(
      () => connected.reject(new Error("Private PTY WebSocket connection timed out")),
      CONNECT_TIMEOUT_MS,
    )
    try {
      await connected.promise
    } finally {
      clearTimeout(timer)
    }
  }

  async function resizePty(cols: number, rows: number) {
    await host.client.pty.update({ location, ptyID, size: { cols, rows } })
  }

  try {
    await resizePty(COLUMNS, ROWS)
    await connect(await connectUrl())
    return {
      screen,
      close,
      send(value: string) {
        assert.equal(socket?.readyState, WebSocket.OPEN)
        socket!.send(value)
      },
      until(value: string) {
        return screen.until((view) => view.includes(value), JSON.stringify(value))
      },
      snapshot(label: string) {
        snapshots.push({ label, view: screen.text() })
      },
      async resize(cols: number, rows: number) {
        screen.resize(cols, rows)
        await resizePty(cols, rows)
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
