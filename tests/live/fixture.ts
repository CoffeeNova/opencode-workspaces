import { OpenCode } from "@opencode/client"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const CAPABILITY_RUNTIME = "2.0.32"
export const CAPABILITY_SDK = "2.0.30"
export const slash = (value: string) => value.replaceAll("\\", "/")

export async function openCodeExecutable() {
  let executable =
    Bun.which(process.platform === "win32" ? "opencode.exe" : "opencode") ?? Bun.which("opencode")
  if (!executable) throw new Error("OpenCode is not on PATH")
  if (process.platform === "win32" && !executable.toLowerCase().endsWith(".exe")) {
    executable = path.join(
      path.dirname(executable),
      "node_modules",
      "@opencode",
      "cli",
      "bin",
      "opencode.exe",
    )
    await fs.access(executable)
  }
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
  if (
    code ||
    !new RegExp(`(?:^|v)${CAPABILITY_RUNTIME.replaceAll(".", "\\.")}$`).test(
      output.trim().replace(/^opencode /, ""),
    )
  ) {
    throw new Error(
      `Capability probes require CLI ${CAPABILITY_RUNTIME}; found ${output.trim() || error.trim()}`,
    )
  }
  return executable
}

// Deliberately do not inherit provider keys, OPENCODE_* overrides, or user config.
// These paths/flags are checked against the v2.0.32 CLI fixture and Global sources.
export function isolatedEnvironment(base: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      /^(?:path|systemroot|windir|comspec|pathext|temp|tmp|lang|lc_all)$/i.test(key)
    )
      env[key] = value
  }
  return {
    ...env,
    HOME: path.join(base, "home"),
    USERPROFILE: path.join(base, "home"),
    // Prevent the private fixture from discovering machine-wide plugins/config.
    ProgramData: path.join(base, "system"),
    OPENCODE_TEST_HOME: path.join(base, "home"),
    OPENCODE_CONFIG_DIR: path.join(base, "config"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({
      highlights: false,
      animations: false,
      attention: { sound: false, notifications: false },
    }),
    OPENCODE_DB: path.join(base, "data", "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_STATE_HOME: path.join(base, "state"),
    OPENCODE_PASSWORD: randomUUID(),
  }
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
  for (const directory of [
    launch,
    other,
    rootA,
    rootB,
    plain,
    env.HOME!,
    env.OPENCODE_CONFIG_DIR!,
    path.dirname(env.OPENCODE_DB!),
  ]) {
    await fs.mkdir(directory, { recursive: true })
  }
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "workspace-fixture/fixture-coder",
    providers: {
      "workspace-fixture": {
        name: "Disposable scripted provider",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${providerOrigin}/v1`, apiKey: "fixture-not-a-credential" },
        models: {
          ...Object.fromEntries(
            ["fixture-coder", "gpt-5.2"].map((id) => [
              id,
              { capabilities: { tools: true }, limit: { context: 128_000, output: 4096 } },
            ]),
          ),
          "fixture-small": {
            capabilities: { tools: true },
            limit: { context: 8192, output: 1024 },
          },
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
  await fs.writeFile(
    path.join(base, "formatter.cjs"),
    `const fs = require('node:fs')\nfs.appendFileSync(process.argv[2], 'FORMATTED\\n')\nfs.appendFileSync(${JSON.stringify(path.join(base, "formatter-runs.jsonl"))}, JSON.stringify({ file: process.argv[2], cwd: process.cwd() }) + '\\n')\n`,
  )
  await fs.writeFile(path.join(launch, "opencode.json"), JSON.stringify(config, null, 2))
  await fs.writeFile(
    path.join(launch, "AGENTS.md"),
    "LAUNCH_RULE_MARKER: launch Location instructions.\n",
  )
  for (const [directory, marker] of [
    [rootA, "ROOT_A_RULE_MARKER"],
    [rootB, "ROOT_B_RULE_MARKER"],
  ] as const) {
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
    await fs.writeFile(
      path.join(directory, "answer.test.mjs"),
      "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { answer } from './src/answer.mjs'\ntest('answer', () => assert.equal(answer, 3))\n",
    )
  }
  async function command(args: string[], cwd: string) {
    const child = Bun.spawn(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      signal: AbortSignal.timeout(30_000),
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(`Fixture command failed: ${args[0]} (${code}) ${stderr || stdout}`)
    return stdout
  }
  for (const directory of [launch, rootA, rootB]) {
    await command(["git", "init", "--quiet"], directory)
    await command(["git", "add", "."], directory)
    await command(
      [
        "git",
        "-c",
        "user.name=Capability Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      directory,
    )
  }
  return { base, launch, other, rootA, rootB, plain, env }
}

export async function startLiveServer(
  executable: string,
  fixture: Awaited<ReturnType<typeof createLiveFixture>>,
) {
  const server = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
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
    30_000,
  )
  const output: string[] = []
  async function drain(stream: ReadableStream<Uint8Array>) {
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
  const drains = [drain(server.stdout), drain(server.stderr)]
  for (const task of drains) void task.catch(ready.reject)
  void server.exited.then((code) =>
    ready.reject(new Error(`Private capability server exited (${code})`)),
  )
  async function stop() {
    clearTimeout(timer)
    if (server.exitCode === null && process.platform === "win32") {
      const child = Bun.spawn(["taskkill.exe", "/PID", String(server.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      if ((await child.exited) !== 0) server.kill()
    } else if (server.exitCode === null) server.kill()
    await server.exited
    await Promise.allSettled(drains)
    await fs.writeFile(path.join(fixture.base, "server-output.log"), output.join(""))
  }
  try {
    const url = await ready.promise
    clearTimeout(timer)
    const client = OpenCode.make({
      baseUrl: url,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${fixture.env.OPENCODE_PASSWORD}`).toString("base64")}`,
      },
    })
    return { client, url, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
