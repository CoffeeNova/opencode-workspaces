import { Terminal } from "@xterm/headless"

// A real VT parser for the real PTY stream. Searching an ANSI transcript alone
// can incorrectly accept text that an intervening dialog already erased.
export function terminalScreen(
  cols: number,
  rows: number,
  reply: (value: string) => void = () => {},
) {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
    logLevel: "off",
  })
  const response = terminal.onData(reply)
  const listeners = new Set<() => void>()
  let ended: Error | undefined
  let writes = Promise.resolve()
  const text = () => {
    const buffer = terminal.buffer.active
    return Array.from(
      { length: terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
    ).join("\n")
  }
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    text,
    write(value: string) {
      writes = writes
        .then(() => new Promise<void>((resolve) => terminal.write(value, resolve)))
        .then(notify)
      return writes
    },
    resize(width: number, height: number) {
      terminal.resize(width, height)
      notify()
    },
    async until(check: (view: string) => boolean, description: string, timeoutMs = 30_000) {
      await writes
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            finish(new Error(`Real TUI did not show ${description}\nCurrent viewport:\n${text()}`)),
          timeoutMs,
        )
        function finish(error?: Error) {
          clearTimeout(timer)
          listeners.delete(inspect)
          if (error) reject(error)
          else resolve()
        }
        function inspect() {
          if (ended) finish(ended)
          else if (check(text())) finish()
        }
        listeners.add(inspect)
        inspect()
      })
    },
    end(error = new Error("Real TUI PTY ended unexpectedly")) {
      ended = error
      notify()
    },
    async dispose() {
      ended = new Error("Terminal screen disposed")
      notify()
      try {
        await writes
      } finally {
        response.dispose()
        terminal.dispose()
      }
    },
  }
}
