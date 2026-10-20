import * as fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ENTRYPOINTS, HOST_EXTERNALS } from "./lib/externals.ts"

const EXPORTS = { ".": "./index.js", "./tui": "./tui.js", "./rpc": "./rpc.js" }

const root = path.resolve(import.meta.dir, "..")
const output = path.join(root, "dist")

const Versions = z.record(z.string(), z.string())
const Manifest = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  engines: Versions,
  dependencies: Versions,
  peerDependencies: Versions,
})

async function readManifest() {
  const source = await Bun.file(path.join(root, "package.json")).json()
  return Manifest.parse(source)
}

async function bundle() {
  const result = await Bun.build({
    entrypoints: ENTRYPOINTS.map((file) => path.join(root, "src", file)),
    outdir: output,
    target: "bun",
    format: "esm",
    splitting: true,
    sourcemap: "external",
    external: HOST_EXTERNALS,
  })
  if (!result.success) throw new AggregateError(result.logs, "Workspace package build failed")
  return result
}

function distManifest(manifest: z.infer<typeof Manifest>, files: string[]) {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: "module",
    exports: EXPORTS,
    engines: manifest.engines,
    dependencies: manifest.dependencies,
    peerDependencies: manifest.peerDependencies,
    files: [...files, "README.md"],
  }
}

const manifest = await readManifest()
const result = await bundle()
const outputNames = result.outputs.map((file) => path.basename(file.path))
const packageJson = JSON.stringify(distManifest(manifest, outputNames), null, 2) + "\n"
await fs.writeFile(path.join(output, "package.json"), packageJson)
await fs.copyFile(path.join(root, "README.md"), path.join(output, "README.md"))
console.log(`Built OpenCode server/TUI/RPC package: ${output}`)
