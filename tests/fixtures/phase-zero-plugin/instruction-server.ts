import type { Context } from "@opencode/plugin/promise/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import * as fs from "node:fs/promises"
import path from "node:path"
import { InstructionProbe } from "./instruction-rpc.ts"
import { instructionBlock, instructionDelivery, InstructionError, patchTargets } from "./instructions.ts"

export async function registerInstructionProbe(ctx: Context, fixture: string, record: (kind: string, data: unknown) => Promise<void>) {
  const deliveries = new Map<string, ReturnType<typeof instructionDelivery>>()
  const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  const canonical = await fs.realpath(ctx.location.directory)
  await ctx.rpc.register(InstructionProbe, {
    activate: async (input, call) => {
      const session = await ctx.session.get({ sessionID: input.sessionID })
      if (key(await fs.realpath(session.location.directory)) !== key(canonical) || deliveries.has(session.id)
        || (await ctx.session.context({ sessionID: session.id })).length) {
        return call.error("invalid_fixture_session", "Instruction probe requires a new empty session in this Location", { sessionID: session.id })
      }
      const roots = [{ alias: "a", path: await fs.realpath(path.join(fixture, "repo a")) }]
      if (input.roots === "both") roots.push({ alias: "b", path: await fs.realpath(path.join(fixture, "repo-b")) })
      if (input.roots === "overlap") roots.push({ alias: "nested", path: await fs.realpath(path.join(fixture, "repo a", "src")) })
      deliveries.set(session.id, instructionDelivery(roots, async (source) => {
        await ctx.permission.assert({ sessionID: session.id, action: "external_directory", resources: [path.dirname(source)], save: [] })
        await ctx.permission.assert({ sessionID: session.id, action: "read", resources: [source], save: [] })
      }))
      return {}
    },
  })
  await ctx.session.hook("context", async (event) => {
    const delivery = deliveries.get(event.sessionID)
    if (!delivery) return
    const session = await ctx.session.get({ sessionID: event.sessionID })
    if (key(await fs.realpath(session.location.directory)) !== key(canonical)) {
      delivery.invalidate()
      throw new Error("Instruction fixture session moved to another Location")
    }
    const models = await ctx.model.list()
    const model = models.data.find((candidate) => candidate.providerID === event.model.providerID && candidate.id === event.model.id)
    const snapshot = await delivery.capture(model?.limit.context ?? 0)
    event.system.push({ type: "text", text: instructionBlock(snapshot) })
    // Fingerprints/status only; never instruction bodies in this diagnostic.
    await record("instructions.capture", { sessionID: event.sessionID, requestID: snapshot.requestID, errors: snapshot.errors,
      sources: snapshot.sources.map((source) => {
        if (source.status !== "loaded") return source
        const { content: _content, ...fingerprint } = source
        return fingerprint
      }) })
  })
  await ctx.session.hook("compaction", (event) => { deliveries.get(event.sessionID)?.invalidate() })
  await ctx.tool.hook("execute.before", async (event) => {
    const delivery = deliveries.get(event.sessionID)
    if (!delivery || !["read", "edit", "write", "patch", "shell"].includes(event.tool)) return
    const input = event.input as { path?: unknown; patchText?: unknown; workdir?: unknown }
    try {
      const targets = event.tool === "patch" && typeof input.patchText === "string" ? patchTargets(input.patchText)
        : event.tool === "shell" && typeof input.workdir === "string" ? [input.workdir]
        : typeof input.path === "string" ? [input.path] : []
      if (!targets.length) throw new InstructionError("UNSUPPORTED_TARGET", "Explicit native path/workdir required")
      if (event.tool === "read") await delivery.discover(targets)
      else {
        const requestID = await delivery.preflight(event.messageID, targets)
        await record("instructions.preflight", { sessionID: event.sessionID, id: event.id, requestID, targets })
      }
    } catch (error) {
      if (!(error instanceof InstructionError)) throw error // Native permission control flow is preserved.
      await record("instructions.rejected", { sessionID: event.sessionID, id: event.id, code: error.code })
      throw new ToolError({ message: error.message })
    }
  })
}
