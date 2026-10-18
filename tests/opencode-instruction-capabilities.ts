import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { CAPABILITY_RUNTIME, CAPABILITY_SDK, createCapabilityFixture, openCodeExecutable, slash, startCapabilityServer } from "./helpers/capability-fixture.ts"
import { checkInstructionCapability } from "./helpers/instruction-capability.ts"
import { scriptedProvider } from "./helpers/scripted-provider.ts"

// Opt-in independent instruction gate; no journal/binding candidate is used.
const { provider, requests, replies, nativeHold } = scriptedProvider()
let fixture: Awaited<ReturnType<typeof createCapabilityFixture>> | undefined
let host: Awaited<ReturnType<typeof startCapabilityServer>> | undefined
let passed = false
try {
  fixture = await createCapabilityFixture(provider.url.origin)
  host = await startCapabilityServer(await openCodeExecutable(), fixture)
  const location = { directory: slash(fixture.launch) }
  await host.client.model.list({ location })
  const plugins = await host.client.plugin.list({ location })
  assert.deepEqual(plugins.data.filter((plugin) => !plugin.id?.startsWith("opencode.")).map((plugin) => [plugin.id, plugin.state.status]), [["workspace-manager.capability-probe", "active"]])
  const instructions = await checkInstructionCapability(host.client, fixture, requests, (reply) => { replies.push(reply) })
  assert.equal(replies.length, 0)
  await fs.writeFile(path.join(fixture.base, "instruction-results.json"), JSON.stringify({ runtime: CAPABILITY_RUNTIME, sdk: CAPABILITY_SDK, bun: Bun.version, ...instructions }, null, 2))
  passed = true
} finally {
  try {
    if (fixture) await fs.writeFile(path.join(fixture.base, "provider-requests.json"), JSON.stringify({ sdk: CAPABILITY_SDK, requests }, null, 2))
  } finally {
    nativeHold.release.resolve([])
    try { await host?.stop() } finally { await provider.stop(true) }
  }
  if (fixture && passed && !process.argv.includes("--keep")) await fs.rm(fixture.base, { recursive: true, force: true })
  else if (fixture) console.log(`Retained disposable fixture: ${fixture.base}`)
}
