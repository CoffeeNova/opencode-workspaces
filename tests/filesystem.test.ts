import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { canonicalTarget, checkedTarget, overlapsRoots } from "../src/infrastructure/paths.ts"
import { searchWorkspace, walk, type GlobSearchInput, type GlobSearchResult, type GrepSearchInput, type GrepSearchResult, type SearchInput, type SearchResult } from "../src/infrastructure/search.ts"

const unix = (value: string) => value.replaceAll("\\", "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase())

async function fixture() {
  const temporary = path.join(tmpdir(), "opencode")
  await fs.mkdir(temporary, { recursive: true })
  const base = await fs.realpath(await fs.mkdtemp(path.join(temporary, "workspace-filesystem-")))
  const docs = path.join(base, "external docs")
  const src = path.join(base, "external-src")
  const outside = path.join(base, "outside")
  await Promise.all([docs, src, outside].map((dir) => fs.mkdir(dir)))
  return {
    base, docs, src, outside, controller: new AbortController(),
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

let h: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => { h = await fixture() })
afterEach(async () => { await h.dispose() })

describe("production native path policy", () => {
  const roots = () => [{ path: unix(h.docs) }, { path: unix(h.src) }]

  test("rejects outside directory aliases into selected roots for existing and new targets", async () => {
    await h.write(h.docs, "visible.txt", "visible")
    await h.write(h.docs, ".env.fixture", "never read")
    const linked = path.join(h.outside, "docs-alias")
    await fs.symlink(h.docs, linked, process.platform === "win32" ? "junction" : "dir")
    await expect(checkedTarget(path.join(linked, "visible.txt"), roots())).rejects.toThrow("OUTSIDE_ROOT")
    await expect(checkedTarget(path.join(linked, "new/nested.txt"), roots())).rejects.toThrow("OUTSIDE_ROOT")
    await expect(checkedTarget(path.join(linked, ".env.fixture"), roots())).rejects.toThrow("DENIED_PATH")
    expect(await canonicalTarget(path.join(linked, "new/nested.txt"))).toBe(unix(path.join(h.docs, "new/nested.txt")))
    expect(await overlapsRoots(linked, roots())).toBe(true)
    expect(await overlapsRoots(h.docs, roots())).toBe(true)
    expect(await overlapsRoots(h.base, roots())).toBe(true)
  })

  test("preserves unrelated explicit paths and canonical workspace creation paths", async () => {
    await h.write(h.outside, "visible.txt", "outside")
    expect(await checkedTarget(path.join(h.outside, "visible.txt"), roots())).toBeUndefined()
    expect(await checkedTarget(path.join(h.outside, ".env.fixture"), roots())).toBeUndefined()
    expect(await checkedTarget(path.join(h.docs, "new/nested.txt"), roots())).toBe(unix(path.join(h.docs, "new/nested.txt")))
    expect(await overlapsRoots(h.outside, roots())).toBe(false)
    await expect(checkedTarget("docs:/visible.txt", roots())).rejects.toThrow("INVALID_PATH")
  })

  test("leaves unrelated resolution failures to native tools without hiding covered failures", async () => {
    const realpath = spyOn(fs, "realpath")
    try {
      for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EBUSY", "ENAMETOOLONG"]) {
        const problem = Object.assign(new Error("Native filesystem error"), { code })
        realpath.mockRejectedValueOnce(problem)
        expect(await checkedTarget(path.join(h.outside, "unavailable.txt"), roots())).toBeUndefined()
        realpath.mockRejectedValueOnce(problem)
        await expect(checkedTarget(path.join(h.docs, "unavailable.txt"), roots())).rejects.toBe(problem)
        realpath.mockRejectedValueOnce(problem)
        expect(await overlapsRoots(h.outside, roots())).toBe(false)
      }
    } finally { realpath.mockRestore() }
  })

  test("rejects outward links and sensitive destinations between registered roots", async () => {
    await h.write(h.src, ".env.fixture", "never read")
    const external = path.join(h.docs, "outside")
    const sibling = path.join(h.docs, "sibling")
    await fs.symlink(h.outside, external, process.platform === "win32" ? "junction" : "dir")
    await fs.symlink(h.src, sibling, process.platform === "win32" ? "junction" : "dir")
    await expect(checkedTarget(path.join(external, "new/file.txt"), roots())).rejects.toThrow("OUTSIDE_ROOT")
    await expect(checkedTarget(path.join(sibling, ".env.fixture"), roots())).rejects.toThrow("DENIED_PATH")
  })
})

describe("session workspace search service", () => {
  const inputRoots = () => [{ alias: "docs", path: unix(h.docs) }, { alias: "src", path: unix(h.src) }]
  const access = () => ({ signal: h.controller.signal, assert: async (_action: string, _resource: string) => {} })
  function search(input: GlobSearchInput): Promise<GlobSearchResult>
  function search(input: GrepSearchInput): Promise<GrepSearchResult>
  function search(input: SearchInput): Promise<SearchResult>
  function search(input: SearchInput) { return searchWorkspace(inputRoots(), input, access()) }

  test("shares bounded quotas fairly, distinguishes duplicate names, and supports alias filters", async () => {
    await Promise.all(Array.from({ length: 105 }, (_, index) => h.write(h.docs, `many-${String(index).padStart(3, "0")}.txt`, "needle\n".repeat(2))))
    await h.write(h.docs, "same.txt", "needle docs")
    await h.write(h.src, "same.txt", "needle src")
    const glob = await search({ kind: "glob", pattern: "**/*.txt" })
    expect(glob.files).toHaveLength(101)
    expect(glob.files).toContain("src:/same.txt")
    expect(glob.roots).toEqual([{ alias: "docs", status: "truncated" }, { alias: "src", status: "complete" }])
    expect(glob.partial).toBe(true)
    const grep = await search({ kind: "grep", pattern: "needle" })
    expect(grep.matches).toHaveLength(51)
    expect(grep.matches.at(-1)).toEqual({ file: "src:/same.txt", line: 1, text: "needle src" })
    expect(grep.truncated).toBe(true)
    expect((await search({ kind: "glob", pattern: "src:/**/*.txt" })).files).toEqual(["src:/same.txt"])
    expect((await search({ kind: "grep", pattern: "needle", alias: "src" })).matches).toHaveLength(1)
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
    await fs.symlink(h.outside, path.join(h.docs, "linked"), process.platform === "win32" ? "junction" : "dir")
    const result = await search({ kind: "grep", pattern: "needle", exclude: ["excluded.txt"] })
    expect(result.matches).toEqual([{ file: "docs:/sub/keep.log", line: 1, text: "needle kept" }])
    expect(result.partial).toBe(false)
    const scoped = await search({ kind: "grep", pattern: "needle", include: "**/*.log", alias: "docs" })
    expect(scoped.matches).toEqual(result.matches)
    const glob = await search({ kind: "glob", pattern: "**/*", exclude: ["sub/**", "excluded.txt"] })
    expect(glob.files).not.toContain("docs:/sub/keep.log")
    expect(glob.files).not.toContain("docs:/.env.fixture")
    expect(glob.files).not.toContain("docs:/linked/secret.txt")
  })

  test("reports missing roots without hiding later results and assigns overlapping files once", async () => {
    await h.write(h.src, "same.txt", "needle")
    await fs.rm(h.docs, { recursive: true })
    const partial = await search({ kind: "glob", pattern: "**/*" })
    expect(partial.files).toEqual(["src:/same.txt"])
    expect(partial.roots).toEqual([{ alias: "docs", status: "unavailable", code: "ENOENT" }, { alias: "src", status: "complete" }])
    expect(partial.partial).toBe(true)
    await h.write(h.src, "nested/file.txt", "needle")
    const roots = [inputRoots()[1]!, { alias: "nested", path: unix(path.join(h.src, "nested")) }]
    expect((await searchWorkspace(roots, { kind: "glob", pattern: "**/*.txt" }, access())).files).toEqual(["src:/same.txt", "nested:/file.txt"])
  })

  test("keeps permission rejection and cancellation as control flow and validates patterns", async () => {
    await h.write(h.src, "file.txt", "needle")
    const rejection = Object.assign(new Error("native read denied"), { code: "EACCES" })
    await expect(searchWorkspace(inputRoots(), { kind: "grep", pattern: "needle" }, { ...access(), assert: async (action) => { if (action === "read") throw rejection } })).rejects.toBe(rejection)
    await h.write(h.docs, ".gitignore", "ignored.txt\n")
    const missingPermission = Object.assign(new Error("native permission rejection"), { code: "ENOENT" })
    await expect(searchWorkspace(inputRoots(), { kind: "glob", pattern: "**/*" }, { ...access(), assert: async (action) => { if (action === "read") throw missingPermission } })).rejects.toBe(missingPermission)
    const abort = new Error("cancelled search")
    await expect(searchWorkspace(inputRoots(), { kind: "grep", pattern: "needle" }, { ...access(), assert: async (action) => { if (action === "read") h.controller.abort(abort) } })).rejects.toBe(abort)
    h.controller = new AbortController()
    for (const input of [{ kind: "glob", pattern: "../**" }, { kind: "glob", pattern: "docs:/**/*", alias: "src" }, { kind: "grep", pattern: "[" }, { kind: "grep", pattern: "x", include: "../**" }, { kind: "glob", pattern: "**/*", alias: "unknown" }] satisfies SearchInput[]) {
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
    const clipped = await search({ kind: "grep", pattern: "needle", alias: "src", include: "over.txt" })
    expect(clipped.matches[0]!.text).toEndWith("[line truncated]")
    const iterator = walk([inputRoots()[1]!], h.controller.signal, { maxEntries: 1 })
    await expect(iterator.next()).rejects.toThrow("SEARCH_LIMIT")
  })

  test("bounds per-root grep input bytes while retaining a later root's results", async () => {
    await Promise.all(Array.from({ length: 42 }, (_, index) => h.write(h.docs, `data-${index}.txt`, "x".repeat(200 * 1024))))
    await h.write(h.src, "visible.txt", "needle")
    const result = await search({ kind: "grep", pattern: "needle" })
    expect(result.matches).toEqual([{ file: "src:/visible.txt", line: 1, text: "needle" }])
    expect(result.roots[0]).toEqual({ alias: "docs", status: "truncated", code: "SEARCH_LIMIT" })
    expect(result.partial).toBe(true)
  })
})

test.skipIf(process.platform !== "win32")("README commands parse with the real Windows PowerShell 5.1 parser", async () => {
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8")
  const scripts = [...readme.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((match) => match[1]!)
  expect(scripts.length).toBeGreaterThan(0)
  const parser = `
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }
    [Console]::Out.Write($PSVersionTable.PSVersion.Major)
  `
  const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", parser], {
    stdin: new Blob([scripts.join("\n\n")]), stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(stdout).toBe("5")
}, 10_000)
