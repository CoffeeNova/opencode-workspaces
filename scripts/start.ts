import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { z } from "zod"
import { errorCode } from "../src/shared/errors.ts"

const WINDOWS_SHIM = /\.(?:cmd|bat|ps1)$/i
const WORKSPACE_PLUGIN_ID = "workspace-manager.v2"

const root = await fs.realpath(path.resolve(import.meta.dir, ".."))
const registeredPackage = path.join(root, "dist").replaceAll("\\", "/")

function nativeExecutable(candidate: string) {
  if (process.platform !== "win32") return candidate
  if (!WINDOWS_SHIM.test(candidate)) return candidate
  return path.join(
    path.dirname(candidate),
    "node_modules",
    "@opencode",
    "cli",
    "bin",
    "opencode.exe",
  )
}

async function findOpenCode() {
  const candidate = process.env.OPENCODE_BIN || Bun.which("opencode.exe") || Bun.which("opencode")
  const executable = candidate && nativeExecutable(candidate)
  if (executable && (await Bun.file(executable).exists())) return executable
  throw new Error(
    "OpenCode V2 was not found. Install OpenCode or set OPENCODE_BIN to its native executable path.",
  )
}

function launcherDirectory() {
  const data =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
  return path.resolve(
    process.env.OPENCODE_WORKSPACE_LAUNCHER || path.join(data, "opencode-workspaces", "launcher"),
  )
}

function launcherConfigText() {
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: registeredPackage }],
  }
  return JSON.stringify(config, null, 2) + "\n"
}

async function createLauncherConfig(configPath: string) {
  const config = await fs.open(configPath, "wx", 0o600)
  try {
    await config.writeFile(launcherConfigText())
    await config.sync()
  } finally {
    await config.close()
  }
}

function configuredPackage(plugin: unknown) {
  if (typeof plugin === "string") return plugin
  if (typeof plugin !== "object" || plugin === null) return undefined
  if (!("package" in plugin)) return undefined
  return plugin.package
}

async function registersThisPackage(configPath: string) {
  const config = z
    .object({ plugins: z.array(z.unknown()) })
    .safeParse(await Bun.file(configPath).json())
  if (!config.success) return false
  return config.data.plugins.some((plugin) => configuredPackage(plugin) === registeredPackage)
}

async function ensureLauncherConfig(launcher: string, configPath: string) {
  await fs.mkdir(launcher, { recursive: true, mode: 0o700 })
  try {
    await createLauncherConfig(configPath)
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error
    if (await registersThisPackage(configPath)) return
    throw new Error(
      `Existing launcher configuration was not overwritten: ${configPath}. Set OPENCODE_WORKSPACE_LAUNCHER to a different empty folder or configure this package explicitly.`,
    )
  }
}

async function verifyService(launcher: string, configPath: string) {
  const service = await Service.discover()
  if (!service) return
  const client = OpenCode.make({
    baseUrl: service.url,
    headers: Service.headers({ url: service.url, ...(service.auth ? { auth: service.auth } : {}) }),
  })
  const location = { directory: launcher.replaceAll("\\", "/") }
  await client.model.list({ location })
  const plugins = await client.plugin.list({ location })
  const workspace = plugins.data.find((plugin) => plugin.id === WORKSPACE_PLUGIN_ID)
  if (workspace && workspace.state.status === "active") return
  throw new Error(
    `The connected OpenCode service has not activated workspace-manager.v2 for ${launcher}. The launcher configuration was retained at ${configPath}; refusing to open a TUI without /workspace.`,
  )
}

const executable = await findOpenCode()
await import("./build.ts")

const launcher = launcherDirectory()
const configPath = path.join(launcher, "opencode.json")
await ensureLauncherConfig(launcher, configPath)
await verifyService(launcher, configPath)

console.log(
  `Opening optional workspace demo launcher in: ${launcher}. Normal plugin use runs opencode from your chosen project directory.`,
)
const command = Bun.spawn([executable, ...Bun.argv.slice(2)], {
  cwd: launcher,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await command.exited)
