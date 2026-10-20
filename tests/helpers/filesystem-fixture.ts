import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const unix = (value: string) =>
  value.replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase())

export async function fixture() {
  const temporary = path.join(tmpdir(), "opencode")
  await fs.mkdir(temporary, { recursive: true })
  const base = await fs.realpath(await fs.mkdtemp(path.join(temporary, "workspace-filesystem-")))
  const docs = path.join(base, "external docs")
  const src = path.join(base, "external-src")
  const outside = path.join(base, "outside")
  await Promise.all([docs, src, outside].map((dir) => fs.mkdir(dir)))
  return {
    base,
    docs,
    src,
    outside,
    controller: new AbortController(),
    async write(root: string, file: string, content: string | Buffer) {
      const absolute = path.join(root, file)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, content)
      return absolute
    },
    async dispose() {
      await fs.rm(base, { recursive: true, force: true })
    },
  }
}
