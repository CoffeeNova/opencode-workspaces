import { heldReply, type ScriptedCall, type ScriptedReply } from "./lifecycle-capability.ts"

// A deterministic loopback responder shared by the opt-in probes, never an AI
// call. The native host still owns tool admission, IDs, permissions and execution.
export function scriptedProvider() {
  const replies: ScriptedReply[] = []
  const requests: unknown[] = []
  const nativeHold = heldReply()
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/native-hold") {
        nativeHold.entered.resolve()
        await nativeHold.release.promise
        return new Response("Fixture hold released")
      }
      const body: unknown = await request.json()
      requests.push(body)
      const model = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? body.model : "fixture-model"
      const scheduled = replies.shift()
      if (!scheduled) return new Response("No scripted reply; model access is disabled", { status: 503 })
      let calls: ScriptedCall[]
      if (Array.isArray(scheduled)) calls = scheduled
      else { scheduled.entered.resolve(); calls = await scheduled.release.promise }
      const chunks = calls.length ? [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call_fixture_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ] : [
        { choices: [{ index: 0, delta: { role: "assistant", content: "Fixture complete." }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { provider, replies, requests, nativeHold }
}
