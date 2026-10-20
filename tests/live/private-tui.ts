import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { slash, type createLiveFixture, type startLiveServer } from "./fixture.ts"
import { terminalScreen } from "./terminal-screen.ts"

// Authenticated public PTY transport. Only the spawned fixture TUI is controlled.
export async function openPrivateTui(
  executable: string,
  fixture: Awaited<ReturnType<typeof createLiveFixture>>,
  host: Awaited<ReturnType<typeof startLiveServer>>,
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
  let socket: WebSocket | undefined
  let closing = false
  let output = ""
  const snapshots: { label: string; view: string }[] = []
  const screen = terminalScreen(110, 32, (reply) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(reply)
  })
  async function close() {
    if (closing) return
    closing = true
    snapshots.push({ label: "final viewport", view: screen.text() })
    socket?.close()
    try {
      await host.client.pty.remove({ location, ptyID: pty.data.id })
    } finally {
      await screen.dispose()
      await fs.writeFile(
        path.join(fixture.base, tag === "home" ? "tui-output.ansi" : `tui-${tag}.ansi`),
        output,
      )
      await fs.writeFile(
        path.join(fixture.base, `tui-${tag}-screens.json`),
        JSON.stringify(snapshots, null, 2),
      )
    }
  }
  try {
    await host.client.pty.update({ location, ptyID: pty.data.id, size: { cols: 110, rows: 32 } })
    const token = await host.client.pty.connect.token({
      location,
      ptyID: pty.data.id,
      "x-opencode-ticket": "1",
    })
    const url = new URL(`/api/pty/${pty.data.id}/connect`, host.url)
    url.protocol = "ws:"
    url.searchParams.set("location[directory]", location.directory)
    url.searchParams.set("ticket", token.data.ticket)
    socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    const connected = Promise.withResolvers<void>()
    socket.addEventListener("open", () => connected.resolve())
    socket.addEventListener("error", () => {
      const error = new Error("Private PTY WebSocket failed")
      connected.reject(error)
      screen.end(error)
    })
    socket.addEventListener("close", () => {
      if (!closing) screen.end()
    })
    socket.addEventListener("message", (event) => {
      if (closing) return
      const text =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer)
      // PTY protocol control frame: NUL + JSON cursor after replay, not VT text.
      if (text.startsWith("\0")) return
      output += text
      if (output.length > 16 * 1024 * 1024) {
        screen.end(new Error("Disposable TUI transcript exceeded 16 MiB"))
        return
      }
      void screen
        .write(text)
        .catch((error: unknown) =>
          screen.end(error instanceof Error ? error : new Error(String(error))),
        )
    })
    const timer = setTimeout(
      () => connected.reject(new Error("Private PTY WebSocket connection timed out")),
      10_000,
    )
    try {
      await connected.promise
    } finally {
      clearTimeout(timer)
    }
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
        await host.client.pty.update({ location, ptyID: pty.data.id, size: { cols, rows } })
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
