import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import path from "node:path"
import { slash, type createCapabilityFixture, type startCapabilityServer } from "./capability-fixture.ts"
import { TuiObservation, type TuiEvent } from "../fixtures/phase-zero-plugin/rpc.ts"
import { openPrivateTui } from "./private-tui.ts"

export function tuiTargetVisible(view: string, directory: string, sessionID?: string) {
  const compactPath = (value: string) => value.replaceAll("\\", "/").replace(/\s/g, "").toLowerCase()
  return compactPath(view).includes(compactPath(directory))
    // Native session IDs are case-sensitive; only the Windows path is folded.
    && view.replace(/\s/g, "").includes(sessionID ?? "none(home)")
}

// Real keyboard input over the private server's public PTY API, not a mocked TUI.
export async function checkTuiCapability(
  executable: string,
  fixture: Awaited<ReturnType<typeof createCapabilityFixture>>,
  host: Awaited<ReturnType<typeof startCapabilityServer>>,
) {
  const { client } = host
  const location = { directory: slash(fixture.launch) }
  const targets = [
    { tag: "session-a", directory: fixture.launch },
    { tag: "session-b", directory: fixture.launch },
    { tag: "other-location", directory: fixture.other },
  ]
  async function inventory() {
    const pages = await Promise.all([fixture.launch, fixture.other].map((directory) => client.session.list({ directory: slash(directory), limit: 100 })))
    return [...new Set(pages.flatMap((page) => page.data.map((session) => session.id)))].sort()
  }
  const expectedSessions = new Set(await inventory())
  const fixtureSessions: string[] = []
  for (const target of targets) {
    const session = await client.session.create({ location: { directory: slash(target.directory) }, title: `TUI acceptance ${target.tag}` })
    expectedSessions.add(session.id)
    fixtureSessions.push(session.id)
  }
  const evidence: { check: string; [key: string]: unknown }[] = []
  const deliveries: { sessionID: string; instanceID: string }[] = []
  let completed = false
  async function observations(): Promise<TuiEvent[]> {
    const trace = await fs.readFile(path.join(fixture.base, "observations.jsonl"), "utf8")
    const lines = trace.split("\n")
    lines.pop() // Ignore an incomplete last append, never accept partial evidence.
    return lines.map((line) => JSON.parse(line) as { kind: string; data: unknown })
      .filter((entry) => entry.kind === "tui.lifecycle").map((entry) => TuiObservation.parse(entry.data))
  }
  async function observed(check: (events: TuiEvent[]) => boolean, description: string) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const events = await observations()
      if (check(events)) return events
      await Bun.sleep(20)
    }
    assert.fail(`TUI telemetry did not confirm ${description}: ${JSON.stringify(await observations())}`)
  }
  try {
    for (const target of [{ tag: "home", directory: fixture.launch, sessionID: undefined }, ...targets.map((value, index) => ({ ...value, sessionID: fixtureSessions[index]! }))]) {
      const previous = new Set((await observations()).map((event) => event.instanceID))
      const ui = await openPrivateTui(executable, fixture, host, target.tag, target.sessionID)
      try {
        await ui.until(target.tag === "home" ? "Ask anything" : `TUI acceptance ${target.tag}`)
        const started = await observed((events) => events.some((event) => event.event === "setup" && !previous.has(event.instanceID)), "one active probe command")
        let instanceID = started.filter((event) => event.event === "setup" && !previous.has(event.instanceID)).at(-1)!.instanceID
        assert.equal(started.filter((event) => event.instanceID === instanceID && event.event === "setup").at(-1)!.commandCopies, 1)
        async function menu(slashCommand = false) {
          if (slashCommand) {
            ui.send("/workspace-probe")
            await ui.until("Workspace capability probe")
          } else {
            ui.send("\x10") // command.palette.show: ctrl+p; not a plugin-imposed binding.
            await ui.until("Commands")
            ui.send("Workspace capability probe")
            await ui.until("Workspace capability probe")
          }
          ui.send("\r")
          await ui.until("Check typed RPC")
        }
        async function inspect() {
          ui.send("\r")
          await ui.until("Workspace probe: RPC ready")
          await ui.screen.until((view) => tuiTargetVisible(view, target.directory, target.sessionID), "the displayed session and canonical Location")
          ui.snapshot("validated session/Location RPC")
          ui.send("\x1b")
          await ui.screen.until((view) => !view.includes("Workspace probe: RPC ready"), "the RPC result dialog to close before typing")
        }
        if (target.tag === "home") {
          await menu(true)
          await inspect()
          await ui.until("Ask anything")
        }
        const draft = `DRAFT_${target.tag.replaceAll("-", "_").toUpperCase()}`
        ui.send(draft)
        await ui.until(draft)
        await menu()
        await inspect()
        await ui.screen.until((view) => view.includes(draft) && !view.includes("Workspace probe: RPC ready"), "the unchanged composer draft")
        ui.send("_AFTER")
        await ui.until(`${draft}_AFTER`)
        await menu()
        ui.send("\x1b")
        await ui.screen.until((view) => view.includes(`${draft}_AFTER`) && !view.includes("Check typed RPC"), "draft after cancelling the menu")
        ui.snapshot("palette and Escape preserve draft")
        evidence.push({ check: "draft-and-session-routing", target: target.tag, sessionID: target.sessionID ?? null, directory: target.directory })

        if (target.tag === "home") {
          async function dialogFlow(cancel: boolean) {
            await menu()
            ui.send("\x1b[B\r")
            await ui.until("Finish dialog check")
            ui.send("\x0f") // Dialog-local Change label action: replaces the select.
            await ui.until("Workspace probe label")
            if (cancel) ui.send("\x1b")
            else {
              ui.send("fixture-label\r")
              await ui.until("Label: fixture-label")
              ui.send("\r")
              await ui.until("Workspace probe: dialog flow complete")
              ui.send("\x1b")
            }
            await ui.screen.until((view) => view.includes(`${draft}_AFTER`) && !view.includes("Workspace probe label")
              && !view.includes("Finish dialog check") && !view.includes("Workspace probe: dialog flow complete"), "draft after native dialog replacement")
            ui.snapshot(cancel ? "replacement prompt cancelled" : "replacement flow completed")
          }
          await dialogFlow(false)
          await dialogFlow(true)
          evidence.push({ check: "native-select-prompt-replacement-and-cancellation" })

          async function event() {
            const created = await client.session.create({ location, title: "TUI listener cleanup sentinel" })
            expectedSessions.add(created.id)
            fixtureSessions.push(created.id)
            deliveries.push({ sessionID: created.id, instanceID })
            await observed((events) => events.some((item) => item.event === "session-event" && item.sessionID === created.id && item.instanceID === instanceID), "one event callback")
          }
          await event()
          for (const pendingDialog of [false, true]) {
            if (pendingDialog) await menu()
            const oldID = instanceID
            const known = new Set((await observations()).map((item) => item.instanceID))
            // Public local-source watch, modifying only this generated fixture file.
            await fs.appendFile(path.join(fixture.packageDirectory, "tui.js"), `\n// Phase-zero reload ${crypto.randomUUID()}\n`)
            const reloaded = await observed((events) => events.some((item) => item.instanceID === oldID && item.event === "cleanup")
              && events.some((item) => item.event === "setup" && !known.has(item.instanceID)), "source-watch cleanup and fresh setup")
            const setup = reloaded.filter((item) => item.event === "setup" && !known.has(item.instanceID)).at(-1)!
            instanceID = setup.instanceID
            assert.equal(setup.commandCopies, 1, "Reload must not duplicate command layers")
            await ui.screen.until((view) => view.includes(`${draft}_AFTER`) && !view.includes("Check typed RPC"), "draft preserved through plugin reload")
            await event()
            await menu()
            await inspect()
            await ui.screen.until((view) => view.includes(`${draft}_AFTER`) && !view.includes("Workspace probe: RPC ready"), "working command after reload")
            evidence.push({ check: "source-watch-reload", pendingDialog, oldID, instanceID, commandCopies: 1 })
            ui.snapshot(pendingDialog ? "reload closed owned menu" : "idle source reload")
          }
        }
        await ui.resize(64, 24)
        await menu()
        await inspect()
        await ui.screen.until((view) => view.includes(`${draft}_AFTER`) && !view.includes("Workspace probe: RPC ready"), "draft at narrow terminal width")
        ui.snapshot("64-column terminal")
        evidence.push({ check: "narrow-terminal", target: target.tag, cols: 64, rows: 24 })
      } finally { await ui.close() }
    }
    const events = await observations()
    for (const delivery of deliveries) {
      assert.deepEqual(events.filter((event) => event.event === "session-event" && event.sessionID === delivery.sessionID)
        .map((event) => event.instanceID), [delivery.instanceID], "Old plugin listeners must not receive an event after reload")
    }
    for (const event of events.filter((event) => event.event === "command" || event.event === "setup")) assert.equal(event.commandCopies, 1)
    for (const sessionID of fixtureSessions) assert.deepEqual(await client.session.context({ sessionID }), [], "TUI checks must not synthesize messages")
    assert.deepEqual(await inventory(), [...expectedSessions].sort(), "UI administration must not implicitly create a session")
    console.log("PASS real TUI slash/palette RPC + home/session/foreign-Location draft preservation")
    console.log("PASS real TUI select/prompt replacement, Escape, and 64-column terminals")
    console.log("PASS real TUI local-source reload, one command layer, and event-listener cleanup")
    completed = true
    return { checks: evidence.length, viewChecks: 4, sourceReloads: 2, listenerDeliveries: deliveries.length, widths: [110, 64] }
  } finally {
    await fs.writeFile(path.join(fixture.base, "tui-results.json"), JSON.stringify({ completed, evidence, deliveries }, null, 2))
  }
}
