import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

const root = await fs.realpath(path.resolve(import.meta.dir, ".."))
const checkoutPackage = root.replaceAll("\\", "/")
const registeredPackage = path.join(root, "dist").replaceAll("\\", "/")
let executable = process.env.OPENCODE_BIN || Bun.which("opencode.exe") || Bun.which("opencode")
if (executable && process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(executable)) {
  executable = path.join(path.dirname(executable), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
}
if (!executable || !await Bun.file(executable).exists()) throw new Error("OpenCode V2 was not found. Install OpenCode or set OPENCODE_BIN to its native executable path.")
await import("./build.ts")

const data = process.platform === "win32" ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local") : process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
const launcher = path.resolve(process.env.OPENCODE_WORKSPACE_LAUNCHER || path.join(data, "opencode-workspaces", "launcher"))
await fs.mkdir(launcher, { recursive: true, mode: 0o700 })
const configPath = path.join(launcher, "opencode.json")
try {
  const config = await fs.open(configPath, "wx", 0o600)
  try {
    await config.writeFile(JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [{ package: registeredPackage }] }, null, 2) + "\n")
    await config.sync()
  } finally { await config.close() }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  const config = await Bun.file(configPath).json()
  const configured = (plugin: unknown) => typeof plugin === "string" ? plugin : typeof plugin === "object" && plugin !== null && "package" in plugin ? plugin.package : undefined
  if (!Array.isArray(config.plugins) || !config.plugins.some((plugin: unknown) => configured(plugin) === registeredPackage || configured(plugin) === checkoutPackage)) {
    throw new Error(`Existing launcher configuration was not overwritten: ${configPath}. Set OPENCODE_WORKSPACE_LAUNCHER to a different empty folder or configure this package explicitly.`)
  }
  if (config.plugins.some((plugin: unknown) => configured(plugin) === checkoutPackage)) {
    config.plugins = config.plugins.map((plugin: unknown) => configured(plugin) === checkoutPackage ? typeof plugin === "string" ? registeredPackage : { ...plugin as object, package: registeredPackage } : plugin)
    const temporary = `${configPath}.${crypto.randomUUID()}.tmp`
    const handle = await fs.open(temporary, "wx", 0o600)
    try { await handle.writeFile(JSON.stringify(config, null, 2) + "\n"); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, configPath)
  }
}
const service = await Service.discover()
if (service) {
  const client = OpenCode.make({ baseUrl: service.url, headers: Service.headers({ url: service.url, ...(service.auth ? { auth: service.auth } : {}) }) })
  await client.model.list({ location: { directory: launcher.replaceAll("\\", "/") } })
  const plugins = await client.plugin.list({ location: { directory: launcher.replaceAll("\\", "/") } })
  const workspace = plugins.data.find((plugin) => plugin.id === "workspace-manager.v2")
  if (!workspace || workspace.state.status !== "active") {
    throw new Error(`The connected OpenCode service has not activated workspace-manager.v2 for ${launcher}. The launcher configuration was retained at ${configPath}; refusing to open a TUI without /workspace.`)
  }
}
console.log(`Opening workspace plugin in: ${launcher}`)
const command = Bun.spawn([executable, ...Bun.argv.slice(2)], { cwd: launcher, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
process.exit(await command.exited)