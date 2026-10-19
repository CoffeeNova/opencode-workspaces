import * as fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const output = path.join(root, "dist")
const manifest = await Bun.file(path.join(root, "package.json")).json()
const result = await Bun.build({
  entrypoints: ["index.ts", "tui.ts", "rpc.ts"].map((file) => path.join(root, "src", file)),
  outdir: output,
  target: "bun",
  format: "esm",
  splitting: true,
  sourcemap: "external",
  external: ["@opencode/plugin", "@opencode/plugin/*", "@opentui/core", "@opentui/solid", "@opentui/solid/*", "solid-js", "solid-js/*"],
})
if (!result.success) throw new AggregateError(result.logs, "Workspace package build failed")
await fs.writeFile(path.join(output, "package.json"), JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  type: "module",
  exports: { ".": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" },
  engines: manifest.engines,
  dependencies: manifest.dependencies,
  peerDependencies: manifest.peerDependencies,
  files: [...result.outputs.map((file) => path.basename(file.path)), "README.md"],
}, null, 2) + "\n")
await fs.copyFile(path.join(root, "README.md"), path.join(output, "README.md"))
console.log(`Built OpenCode server/TUI/RPC package: ${output}`)