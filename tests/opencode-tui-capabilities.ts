import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { CAPABILITY_RUNTIME, CAPABILITY_SDK, createCapabilityFixture, openCodeExecutable, startCapabilityServer } from "./helpers/capability-fixture.ts"
import { checkTuiCapability } from "./helpers/tui-capability.ts"

// Fast opt-in real TUI iteration with the model completely unavailable.
let providerRequests = 0
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  providerRequests++
  return new Response("No provider is available during TUI acceptance", { status: 503 })
} })
let fixture: Awaited<ReturnType<typeof createCapabilityFixture>> | undefined
let host: Awaited<ReturnType<typeof startCapabilityServer>> | undefined
let passed = false
let checks: Awaited<ReturnType<typeof checkTuiCapability>> | undefined
try {
  const executable = await openCodeExecutable()
  fixture = await createCapabilityFixture(provider.url.origin)
  host = await startCapabilityServer(executable, fixture)
  await host.client.model.list({ location: { directory: fixture.launch.replaceAll("\\", "/") } })
  checks = await checkTuiCapability(executable, fixture, host)
  assert.equal(providerRequests, 0, "Every TUI check must work without a model/provider request")
  passed = true
} finally {
  try {
    if (fixture) await fs.writeFile(path.join(fixture.base, "tui-capability-results.json"), JSON.stringify({
      runtime: CAPABILITY_RUNTIME, sdk: CAPABILITY_SDK, bun: Bun.version, screen: "@xterm/headless@5.5.0", providerRequests, passed, checks,
    }, null, 2))
  } finally {
    try { await host?.stop() } finally { await provider.stop(true) }
  }
  if (fixture && passed && !process.argv.includes("--keep")) await fs.rm(fixture.base, { recursive: true, force: true })
  else if (fixture) console.log(`Retained disposable fixture: ${fixture.base}`)
}
