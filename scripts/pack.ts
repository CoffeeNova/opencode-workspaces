import path from "node:path"
import { z } from "zod"

await import("./build.ts")

const root = path.resolve(import.meta.dir, "..")
const DistManifest = z.object({ name: z.string(), version: z.string() })

const manifest = DistManifest.parse(await Bun.file(path.join(root, "dist", "package.json")).json())
const file = path.join(root, `${manifest.name}-${manifest.version}.tgz`)
const command = Bun.spawn([process.execPath, "pm", "pack", "--filename", file], {
  cwd: path.join(root, "dist"),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const exit = await command.exited
if (exit !== 0) process.exit(exit)
console.log(`OpenCode plugin archive: ${file}`)
