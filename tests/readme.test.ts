import { expect, test } from "bun:test"
import * as fs from "node:fs/promises"

// Parses stdin with the real PowerShell parser and reports parse errors on stderr.
const PARSER_SCRIPT = `
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }
  [Console]::Out.Write($PSVersionTable.PSVersion.Major)
`

async function readmePowerShellBlocks() {
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8")
  const blocks = readme.matchAll(/```powershell\r?\n([\s\S]*?)```/g)
  return [...blocks].map((match) => match[1]!)
}

async function parseWithPowerShell(source: string) {
  const child = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", PARSER_SCRIPT],
    { stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test.skipIf(process.platform !== "win32")(
  "README commands parse with the real Windows PowerShell 5.1 parser",
  async () => {
    const scripts = await readmePowerShellBlocks()
    expect(scripts.length).toBeGreaterThan(0)
    const { code, stdout, stderr } = await parseWithPowerShell(scripts.join("\n\n"))
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toBe("5")
  },
  10_000,
)
