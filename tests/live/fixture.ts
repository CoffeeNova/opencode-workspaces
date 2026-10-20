import { OpenCode } from "@opencode/client"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const CAPABILITY_RUNTIME = "2.0.32"
export const CAPABILITY_SDK = "2.0.30"
export const slash = (value: string) => value.replaceAll("\\", "/")

export type LiveFixture = Awaited<ReturnType<typeof createLiveFixture>>
export type LiveHost = Awaited<ReturnType<typeof startLiveServer>>

const SERVER_START_TIMEOUT_MS = 30_000
const FIXTURE_COMMAND_TIMEOUT_MS = 30_000

async function locateExecutable() {
  const found =
    Bun.which(process.platform === "win32" ? "opencode.exe" : "opencode") ?? Bun.which("opencode")
  if (!found) throw new Error("OpenCode is not on PATH")
  if (process.platform !== "win32") return found
  if (found.toLowerCase().endsWith(".exe")) return found
  const native = path.join(
    path.dirname(found),
    "node_modules",
    "@opencode",
    "cli",
    "bin",
    "opencode.exe",
  )
  await fs.access(native)
  return native
}

async function readVersion(executable: string) {
  const version = Bun.spawn([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, output, error] = await Promise.all([
    version.exited,
    new Response(version.stdout).text(),
    new Response(version.stderr).text(),
  ])
  return { code, output: output.trim(), error: error.trim() }
}

function isCapabilityVersion(output: string) {
  const pattern = new RegExp(`(?:^|v)${CAPABILITY_RUNTIME.replaceAll(".", "\\.")}$`)
  return pattern.test(output.replace(/^opencode /, ""))
}

export async function openCodeExecutable() {
  const executable = await locateExecutable()
  const { code, output, error } = await readVersion(executable)
  if (code || !isCapabilityVersion(output)) {
    throw new Error(`Capability probes require CLI ${CAPABILITY_RUNTIME}; found ${output || error}`)
  }
  return executable
}

const INHERITED_VARIABLES = /^(?:path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i

function inheritedEnvironment() {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (INHERITED_VARIABLES.test(key)) env[key] = value
  }
  return env
}

// Deliberately do not inherit provider keys, OPENCODE_* overrides, or user config.
// These paths/flags are checked against the v2.0.32 CLI fixture and Global sources.
export function isolatedEnvironment(base: string): Record<string, string> {
  const cliConfig = {
    highlights: false,
    animations: false,
    attention: { sound: false, notifications: false },
  }
  return {
    ...inheritedEnvironment(),
    HOME: path.join(base, "home"),
    USERPROFILE: path.join(base, "home"),
    // Prevent the private fixture from discovering machine-wide plugins/config.
    ProgramData: path.join(base, "system"),
    OPENCODE_TEST_HOME: path.join(base, "home"),
    OPENCODE_CONFIG_DIR: path.join(base, "config"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify(cliConfig),
    OPENCODE_DB: path.join(base, "data", "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_STATE_HOME: path.join(base, "state"),
    OPENCODE_PASSWORD: randomUUID(),
  }
}

function fixtureModel(context: number, output: number) {
  return { capabilities: { tools: true }, limit: { context, output } }
}

function launchConfig(base: string, providerOrigin: string) {
  const largeModels = ["fixture-coder", "gpt-5.2"].map((id) => [id, fixtureModel(128_000, 4096)])
  return {
    $schema: "https://opencode.ai/config.json",
    model: "workspace-fixture/fixture-coder",
    providers: {
      "workspace-fixture": {
        name: "Disposable scripted provider",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${providerOrigin}/v1`, apiKey: "fixture-not-a-credential" },
        models: {
          ...Object.fromEntries(largeModels),
          "fixture-small": fixtureModel(8192, 1024),
        },
      },
    },
    formatter: {
      "fixture-formatter": {
        command: ["node", slash(path.join(base, "formatter.cjs")), "$FILE"],
        extensions: [".probe"],
      },
    },
    shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
  }
}

function formatterScript(base: string) {
  const runLog = JSON.stringify(path.join(base, "formatter-runs.jsonl"))
  return [
    "const fs = require('node:fs')",
    "fs.appendFileSync(process.argv[2], 'FORMATTED\\n')",
    `fs.appendFileSync(${runLog}, JSON.stringify({ file: process.argv[2], cwd: process.cwd() }) + '\\n')`,
    "",
  ].join("\n")
}

const ANSWER_TEST = [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { answer } from './src/answer.mjs'",
  "test('answer', () => assert.equal(answer, 3))",
  "",
].join("\n")

async function writeRepository(directory: string, marker: string) {
  await fs.mkdir(path.join(directory, "src"))
  await fs.writeFile(
    path.join(directory, "AGENTS.md"),
    `${marker}: instructions apply only to this repository.\n`,
  )
  await fs.writeFile(
    path.join(directory, "src", "AGENTS.md"),
    `${marker}_NESTED: nested instructions.\n`,
  )
  await fs.writeFile(path.join(directory, "src", "answer.mjs"), "export const answer = 1\n")
  await fs.writeFile(path.join(directory, "answer.test.mjs"), ANSWER_TEST)
}

async function runFixtureCommand(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    signal: AbortSignal.timeout(FIXTURE_COMMAND_TIMEOUT_MS),
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Fixture command failed: ${args[0]} (${code}) ${stderr || stdout}`)
  return stdout
}

async function commitRepository(directory: string, env: Record<string, string>) {
  const commit = [
    "git",
    "-c",
    "user.name=Capability Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]
  await runFixtureCommand(["git", "init", "--quiet"], directory, env)
  await runFixtureCommand(["git", "add", "."], directory, env)
  await runFixtureCommand(commit, directory, env)
}

export async function createLiveFixture(providerOrigin: string) {
  if (process.platform !== "win32") {
    throw new Error(
      "This capability harness currently verifies Windows only; validate machine-config isolation before porting it",
    )
  }
  const parent = path.join(tmpdir(), "opencode")
  await fs.mkdir(parent, { recursive: true })
  const base = await fs.realpath(await fs.mkdtemp(path.join(parent, "workspace-live-")))
  const launch = path.join(base, "launch")
  const other = path.join(base, "other-location")
  const rootA = path.join(base, "repo a")
  const rootB = path.join(base, "repo-b")
  const plain = path.join(base, "ordinary-folder")
  const env = isolatedEnvironment(base)
  const directories = [
    launch,
    other,
    rootA,
    rootB,
    plain,
    env.HOME!,
    env.OPENCODE_CONFIG_DIR!,
    path.dirname(env.OPENCODE_DB!),
  ]
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true })
  }
  await fs.writeFile(path.join(base, "formatter.cjs"), formatterScript(base))
  const config = launchConfig(base, providerOrigin)
  await fs.writeFile(path.join(launch, "opencode.json"), JSON.stringify(config, null, 2))
  await fs.writeFile(
    path.join(launch, "AGENTS.md"),
    "LAUNCH_RULE_MARKER: launch Location instructions.\n",
  )
  await writeRepository(rootA, "ROOT_A_RULE_MARKER")
  await writeRepository(rootB, "ROOT_B_RULE_MARKER")
  for (const directory of [launch, rootA, rootB]) {
    await commitRepository(directory, env)
  }
  return { base, launch, other, rootA, rootB, plain, env }
}

function serverCommand(executable: string) {
  return [executable, "serve", "--hostname", "127.0.0.1", "--port", "0"]
}

// Reads a child stream to its end, keeping the full output and resolving `ready`
// with the first loopback URL it prints.
async function drainServerStream(
  stream: ReadableStream<Uint8Array>,
  output: string[],
  ready: ReturnType<typeof Promise.withResolvers<string>>,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let tail = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const text = decoder.decode(next.value, { stream: true })
      tail = (tail + text).slice(-4096)
      output.push(text)
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(tail)
      if (match) ready.resolve(match[0])
    }
  } finally {
    reader.releaseLock()
  }
}

async function killServer(server: Bun.Subprocess) {
  if (server.exitCode !== null) return
  if (process.platform !== "win32") {
    server.kill()
    return
  }
  const taskkill = Bun.spawn(["taskkill.exe", "/PID", String(server.pid), "/T", "/F"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  if ((await taskkill.exited) !== 0) server.kill()
}

function basicAuthorization(password: string | undefined) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

export async function startLiveServer(executable: string, fixture: LiveFixture) {
  const server = Bun.spawn(serverCommand(executable), {
    cwd: fixture.launch,
    env: fixture.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const ready = Promise.withResolvers<string>()
  const timer = setTimeout(
    () => ready.reject(new Error("Private capability server timed out")),
    SERVER_START_TIMEOUT_MS,
  )
  const output: string[] = []
  const drains = [
    drainServerStream(server.stdout, output, ready),
    drainServerStream(server.stderr, output, ready),
  ]
  for (const task of drains) void task.catch(ready.reject)
  void server.exited.then((code) =>
    ready.reject(new Error(`Private capability server exited (${code})`)),
  )
  async function stop() {
    clearTimeout(timer)
    await killServer(server)
    await server.exited
    await Promise.allSettled(drains)
    await fs.writeFile(path.join(fixture.base, "server-output.log"), output.join(""))
  }
  try {
    const url = await ready.promise
    clearTimeout(timer)
    const authorization = basicAuthorization(fixture.env.OPENCODE_PASSWORD)
    const client = OpenCode.make({ baseUrl: url, headers: { authorization } })
    return { client, url, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
