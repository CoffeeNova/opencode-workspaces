import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import { instructionDelivery } from "../../src/instructions/delivery.ts"
import { slash } from "../../src/server/filesystem/paths.ts"
import {
  canonicalTarget,
  checkedTarget,
  overlapsRoots,
} from "../../src/server/filesystem/policy.ts"
import { fixture, unix } from "../helpers/filesystem-fixture.ts"

let h: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  h = await fixture()
})
afterEach(async () => {
  await h.dispose()
})

describe("production native path policy", () => {
  const roots = () => [{ path: unix(h.docs) }, { path: unix(h.src) }]

  test("rejects outside directory aliases into selected roots for existing and new targets", async () => {
    await h.write(h.docs, "visible.txt", "visible")
    await h.write(h.docs, ".env.fixture", "never read")
    const linked = path.join(h.outside, "docs-alias")
    await fs.symlink(h.docs, linked, process.platform === "win32" ? "junction" : "dir")
    await expect(checkedTarget(path.join(linked, "visible.txt"), roots())).rejects.toThrow(
      "OUTSIDE_ROOT",
    )
    await expect(checkedTarget(path.join(linked, "new/nested.txt"), roots())).rejects.toThrow(
      "OUTSIDE_ROOT",
    )
    await expect(checkedTarget(path.join(linked, ".env.fixture"), roots())).rejects.toThrow(
      "DENIED_PATH",
    )
    expect(await canonicalTarget(path.join(linked, "new/nested.txt"))).toBe(
      unix(path.join(h.docs, "new/nested.txt")),
    )
    expect(await overlapsRoots(linked, roots())).toBe(true)
    expect(await overlapsRoots(h.docs, roots())).toBe(true)
    expect(await overlapsRoots(h.base, roots())).toBe(true)
  })

  test("preserves unrelated explicit paths and canonical workspace creation paths", async () => {
    await h.write(h.outside, "visible.txt", "outside")
    expect(await checkedTarget(path.join(h.outside, "visible.txt"), roots())).toBeUndefined()
    expect(await checkedTarget(path.join(h.outside, ".env.fixture"), roots())).toBeUndefined()
    expect(await checkedTarget(path.join(h.docs, "new/nested.txt"), roots())).toBe(
      unix(path.join(h.docs, "new/nested.txt")),
    )
    expect(await overlapsRoots(h.outside, roots())).toBe(false)
    await expect(checkedTarget("docs:/visible.txt", roots())).rejects.toThrow("INVALID_PATH")
  })

  test("leaves unrelated resolution failures to native tools without hiding covered failures", async () => {
    const realpath = spyOn(fs, "realpath")
    try {
      for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EBUSY", "ENAMETOOLONG"]) {
        const problem = Object.assign(new Error("Native filesystem error"), { code })
        realpath.mockRejectedValueOnce(problem)
        expect(
          await checkedTarget(path.join(h.outside, "unavailable.txt"), roots()),
        ).toBeUndefined()
        realpath.mockRejectedValueOnce(problem)
        await expect(checkedTarget(path.join(h.docs, "unavailable.txt"), roots())).rejects.toBe(
          problem,
        )
        realpath.mockRejectedValueOnce(problem)
        expect(await overlapsRoots(h.outside, roots())).toBe(false)
      }
    } finally {
      realpath.mockRestore()
    }
  })

  test("rejects outward links and sensitive destinations between registered roots", async () => {
    await h.write(h.src, ".env.fixture", "never read")
    const external = path.join(h.docs, "outside")
    const sibling = path.join(h.docs, "sibling")
    await fs.symlink(h.outside, external, process.platform === "win32" ? "junction" : "dir")
    await fs.symlink(h.src, sibling, process.platform === "win32" ? "junction" : "dir")
    await expect(checkedTarget(path.join(external, "new/file.txt"), roots())).rejects.toThrow(
      "OUTSIDE_ROOT",
    )
    await expect(checkedTarget(path.join(sibling, ".env.fixture"), roots())).rejects.toThrow(
      "DENIED_PATH",
    )
  })

  test.skipIf(process.platform !== "win32")(
    "checkedTarget matches roots case- and separator-insensitively on Windows",
    async () => {
      const realRoot = slash(h.docs)
      const candidate = realRoot.toUpperCase().replaceAll("/", "\\") + "\\file.txt"
      const result = await checkedTarget(candidate, [{ path: realRoot }])
      expect(result).toBe(slash(candidate))
    },
  )

  test.skipIf(process.platform !== "win32")(
    "instruction scopes deduplicate case variants of one directory",
    async () => {
      await h.write(h.docs, "AGENTS.md", "docs rules")
      const delivery = instructionDelivery(
        [{ alias: "docs", path: h.docs.toLowerCase() }],
        async () => {},
      )
      await delivery.discover([path.join(h.docs.toUpperCase(), "file.txt")])
      const snapshot = await delivery.capture()
      expect(snapshot.errors).toEqual([])
      expect(snapshot.sources).toHaveLength(1)
      expect(snapshot.sources[0]?.status).toBe("loaded")
    },
  )
})
