import path from "node:path"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

// Explicit opt-in integration check: a short-lived loopback-only server, no
// generation, no workspace mutations, and no shared-service/cache operations.
const repository = path.resolve(import.meta.dir, "..")
let executable = Bun.which(process.platform === "win32" ? "opencode.exe" : "opencode") ?? Bun.which("opencode")
if (!executable) throw new Error("OpenCode is not on PATH")
if (process.platform === "win32" && !executable.toLowerCase().endsWith(".exe")) {
  // The V2 npm installation's .cmd/.ps1 wrapper delegates to this binary.
  executable = path.join(path.dirname(executable), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  await fs.access(executable)
}

// Credentials live only in these child processes, never in config or output.
const environment = { ...process.env, OPENCODE_PASSWORD: randomUUID() }
const server = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: repository, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
})
let resolveReady: (url: string) => void
let rejectReady: (error: Error) => void
const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
const timer = setTimeout(() => rejectReady(new Error("Private OpenCode server did not become ready within 20 seconds")), 20_000)
async function drain(stream: ReadableStream<Uint8Array>) {
  let tail = ""
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-4096)
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(tail)
      if (match) resolveReady(match[0])
    }
  } finally {
    reader.releaseLock()
  }
}
const drains = [drain(server.stdout), drain(server.stderr)]
for (const task of drains) void task.catch(rejectReady!)
void server.exited.then((code) => rejectReady(new Error(`Private OpenCode server exited (${code})`)))

type PluginsResponse = {
  location: { directory?: string }
  data: { id?: string; state: { status: string; error?: string; ref?: string }; features: { server?: boolean; tui?: boolean }; source: { path?: string } }[]
}
const normalize = (value: string) => {
  const result = value.replaceAll("\\", "/").replace(/\/$/, "")
  return process.platform === "win32" ? result.toLowerCase() : result
}
try {
  const url = await ready
  clearTimeout(timer)
  async function api(endpoint: string): Promise<string> {
    const child = Bun.spawn([executable!, "api", "--server", url, "get", endpoint], {
      cwd: repository, env: environment, stdout: "pipe", stderr: "pipe", windowsHide: true, signal: AbortSignal.timeout(60_000),
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`Private OpenCode API failed (${code}): ${stderr || stdout}`)
    return stdout
  }
  const scope = `location[directory]=${encodeURIComponent(repository.replaceAll("\\", "/"))}`
  // Plugin inventory alone does not activate a cold Location. A catalog read
  // bootstraps its configured plugins without creating a Session or model call.
  await api(`/api/model?${scope}`)
  const response = JSON.parse(await api(`/api/plugin?${scope}`)) as PluginsResponse
  if (!response.location.directory || normalize(response.location.directory) !== normalize(repository)) {
    throw new Error("Native loader response belongs to an unexpected Location")
  }
  for (const id of ["workspace-manager", "workspace-manager.notifications"]) {
    const plugin = response.data.find((entry) => entry.id === id)
    if (plugin?.state.status !== "active") {
      const failures = response.data.filter((entry) => entry.source.path && normalize(entry.source.path).startsWith(normalize(repository)))
      throw new Error(`Native V2 loader did not activate ${id}: ${JSON.stringify(failures)}`)
    }
    if (id.endsWith(".notifications") && !plugin.features.tui) throw new Error("TUI companion was not discovered")
    console.log(`${id}: active (native OpenCode V2 loader)`)
  }
} finally {
  clearTimeout(timer)
  if (server.exitCode === null && process.platform === "win32") {
    // This PID belongs to the process we just spawned. Include any stdio MCP
    // descendants it started; never kill by executable name or shared-service PID.
    const stop = Bun.spawn(["taskkill.exe", "/PID", String(server.pid), "/T", "/F"], {
      stdout: "ignore", stderr: "ignore", windowsHide: true,
    })
    if (await stop.exited !== 0) server.kill()
  } else if (server.exitCode === null) {
    server.kill()
  }
  await server.exited
  await Promise.allSettled(drains)
}
