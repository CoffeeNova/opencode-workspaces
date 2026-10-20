import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"
import {
  searchWorkspace,
  walk,
  type GlobSearchInput,
  type GlobSearchResult,
  type GrepSearchInput,
  type GrepSearchResult,
  type SearchInput,
  type SearchResult,
} from "../../src/infrastructure/search.ts"
import { fixture, unix } from "../helpers/filesystem-fixture.ts"

let h: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => {
  h = await fixture()
})
afterEach(async () => {
  await h.dispose()
})

describe("session workspace search service", () => {
  const inputRoots = () => [
    { alias: "docs", path: unix(h.docs) },
    { alias: "src", path: unix(h.src) },
  ]
  const access = () => ({
    signal: h.controller.signal,
    assert: async (_action: string, _resource: string) => {},
  })
  function search(input: GlobSearchInput): Promise<GlobSearchResult>
  function search(input: GrepSearchInput): Promise<GrepSearchResult>
  function search(input: SearchInput): Promise<SearchResult>
  function search(input: SearchInput) {
    return searchWorkspace(inputRoots(), input, access())
  }

  test("shares bounded quotas fairly, distinguishes duplicate names, and supports alias filters", async () => {
    await Promise.all(
      Array.from({ length: 105 }, (_, index) =>
        h.write(h.docs, `many-${String(index).padStart(3, "0")}.txt`, "needle\n".repeat(2)),
      ),
    )
    await h.write(h.docs, "same.txt", "needle docs")
    await h.write(h.src, "same.txt", "needle src")
    const glob = await search({ kind: "glob", pattern: "**/*.txt" })
    expect(glob.files).toHaveLength(101)
    expect(glob.files).toContain("src:/same.txt")
    expect(glob.roots).toEqual([
      { alias: "docs", status: "truncated" },
      { alias: "src", status: "complete" },
    ])
    expect(glob.partial).toBe(true)
    const grep = await search({ kind: "grep", pattern: "needle" })
    expect(grep.matches).toHaveLength(51)
    expect(grep.matches.at(-1)).toEqual({ file: "src:/same.txt", line: 1, text: "needle src" })
    expect(grep.truncated).toBe(true)
    expect((await search({ kind: "glob", pattern: "src:/**/*.txt" })).files).toEqual([
      "src:/same.txt",
    ])
    expect((await search({ kind: "grep", pattern: "needle", alias: "src" })).matches).toHaveLength(
      1,
    )
  })

  test("preserves nested ignore, exclusions, sensitive/link, binary and 200 KiB filtering", async () => {
    await h.write(h.docs, ".gitignore", "*.log\nblocked/\n!blocked/hidden.txt\n")
    await h.write(h.docs, "sub/.gitignore", "!keep.log\n")
    await h.write(h.docs, "sub/keep.log", "needle kept")
    await h.write(h.docs, "sub/drop.log", "needle ignored")
    await h.write(h.docs, "blocked/hidden.txt", "needle ignored")
    await h.write(h.docs, "excluded.txt", "needle excluded")
    await h.write(h.docs, ".env.fixture", "needle SECRET")
    await h.write(h.docs, ".ssh/key", "needle SECRET")
    await h.write(h.docs, "binary.txt", Buffer.from("needle\0binary"))
    await h.write(h.docs, "large.txt", "needle" + "x".repeat(200 * 1024))
    await h.write(h.outside, "secret.txt", "needle SECRET")
    await fs.symlink(
      h.outside,
      path.join(h.docs, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const result = await search({ kind: "grep", pattern: "needle", exclude: ["excluded.txt"] })
    expect(result.matches).toEqual([{ file: "docs:/sub/keep.log", line: 1, text: "needle kept" }])
    expect(result.partial).toBe(false)
    const scoped = await search({
      kind: "grep",
      pattern: "needle",
      include: "**/*.log",
      alias: "docs",
    })
    expect(scoped.matches).toEqual(result.matches)
    const glob = await search({
      kind: "glob",
      pattern: "**/*",
      exclude: ["sub/**", "excluded.txt"],
    })
    expect(glob.files).not.toContain("docs:/sub/keep.log")
    expect(glob.files).not.toContain("docs:/.env.fixture")
    expect(glob.files).not.toContain("docs:/linked/secret.txt")
  })

  test("reports missing roots without hiding later results and assigns overlapping files once", async () => {
    await h.write(h.src, "same.txt", "needle")
    await fs.rm(h.docs, { recursive: true })
    const partial = await search({ kind: "glob", pattern: "**/*" })
    expect(partial.files).toEqual(["src:/same.txt"])
    expect(partial.roots).toEqual([
      { alias: "docs", status: "unavailable", code: "ENOENT" },
      { alias: "src", status: "complete" },
    ])
    expect(partial.partial).toBe(true)
    await h.write(h.src, "nested/file.txt", "needle")
    const roots = [inputRoots()[1]!, { alias: "nested", path: unix(path.join(h.src, "nested")) }]
    expect(
      (await searchWorkspace(roots, { kind: "glob", pattern: "**/*.txt" }, access())).files,
    ).toEqual(["src:/same.txt", "nested:/file.txt"])
  })

  test("keeps permission rejection and cancellation as control flow and validates patterns", async () => {
    await h.write(h.src, "file.txt", "needle")
    const rejection = Object.assign(new Error("native read denied"), { code: "EACCES" })
    await expect(
      searchWorkspace(
        inputRoots(),
        { kind: "grep", pattern: "needle" },
        {
          ...access(),
          assert: async (action) => {
            if (action === "read") throw rejection
          },
        },
      ),
    ).rejects.toBe(rejection)
    await h.write(h.docs, ".gitignore", "ignored.txt\n")
    const missingPermission = Object.assign(new Error("native permission rejection"), {
      code: "ENOENT",
    })
    await expect(
      searchWorkspace(
        inputRoots(),
        { kind: "glob", pattern: "**/*" },
        {
          ...access(),
          assert: async (action) => {
            if (action === "read") throw missingPermission
          },
        },
      ),
    ).rejects.toBe(missingPermission)
    const abort = new Error("cancelled search")
    await expect(
      searchWorkspace(
        inputRoots(),
        { kind: "grep", pattern: "needle" },
        {
          ...access(),
          assert: async (action) => {
            if (action === "read") h.controller.abort(abort)
          },
        },
      ),
    ).rejects.toBe(abort)
    h.controller = new AbortController()
    for (const input of [
      { kind: "glob", pattern: "../**" },
      { kind: "glob", pattern: "docs:/**/*", alias: "src" },
      { kind: "grep", pattern: "[" },
      { kind: "grep", pattern: "x", include: "../**" },
      { kind: "glob", pattern: "**/*", alias: "unknown" },
    ] satisfies SearchInput[]) {
      await expect(search(input)).rejects.toThrow()
    }
  })

  test("detects exact caps accurately and enforces the traversal entry budget", async () => {
    await h.write(h.src, "exact.txt", "needle\n".repeat(100))
    const exact = await search({ kind: "grep", pattern: "needle", alias: "src" })
    expect(exact.matches).toHaveLength(100)
    expect(exact.truncated).toBe(false)
    await h.write(h.src, "over.txt", "needle " + "x".repeat(3000))
    expect((await search({ kind: "grep", pattern: "needle", alias: "src" })).truncated).toBe(true)
    const clipped = await search({
      kind: "grep",
      pattern: "needle",
      alias: "src",
      include: "over.txt",
    })
    expect(clipped.matches[0]!.text).toEndWith("[line truncated]")
    const iterator = walk([inputRoots()[1]!], h.controller.signal, { maxEntries: 1 })
    await expect(iterator.next()).rejects.toThrow("SEARCH_LIMIT")
  })

  test("bounds per-root grep input bytes while retaining a later root's results", async () => {
    await Promise.all(
      Array.from({ length: 42 }, (_, index) =>
        h.write(h.docs, `data-${index}.txt`, "x".repeat(200 * 1024)),
      ),
    )
    await h.write(h.src, "visible.txt", "needle")
    const result = await search({ kind: "grep", pattern: "needle" })
    expect(result.matches).toEqual([{ file: "src:/visible.txt", line: 1, text: "needle" }])
    expect(result.roots[0]).toEqual({ alias: "docs", status: "truncated", code: "SEARCH_LIMIT" })
    expect(result.partial).toBe(true)
  })
})
