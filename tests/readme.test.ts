import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"

test.skipIf(process.platform !== "win32")(
  "README commands parse with the real Windows PowerShell 5.1 parser",
  async () => {
    const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8")
    const scripts = [...readme.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map(
      (match) => match[1]!,
    )
    expect(scripts.length).toBeGreaterThan(0)
    const parser = `
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }
    [Console]::Out.Write($PSVersionTable.PSVersion.Major)
  `
    const process = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", parser],
      {
        stdin: new Blob([scripts.join("\n\n")]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toBe("5")
  },
  10_000,
)
