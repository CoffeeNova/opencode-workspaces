export type ScriptedCall = { name: string; input: Record<string, unknown> }
export type ScriptedReply = ScriptedCall[] | ReturnType<typeof heldReply>
export type ScriptedProvider = ReturnType<typeof scriptedProvider>

export function heldReply() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<ScriptedCall[]>(),
  }
}

function requestedModel(body: unknown) {
  if (typeof body !== "object" || body === null) return "fixture-model"
  if (!("model" in body) || typeof body.model !== "string") return "fixture-model"
  return body.model
}

async function resolveCalls(scheduled: ScriptedReply) {
  if (Array.isArray(scheduled)) return scheduled
  scheduled.entered.resolve()
  return scheduled.release.promise
}

function toolCallChunks(calls: ScriptedCall[], requestCount: number) {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: `call_fixture_${requestCount}_${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }))
  return [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: toolCalls },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]
}

function completionChunks() {
  return [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Fixture complete." },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
}

function eventStream(chunks: object[], model: string, requestCount: number) {
  const events = chunks.map((chunk) => {
    const data = {
      id: `fixture-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model,
      ...chunk,
    }
    return `data: ${JSON.stringify(data)}\n\n`
  })
  return new Response(events.join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

// A deterministic loopback responder, never an AI call. The native host still
// owns tool admission, IDs, permissions and execution.
export function scriptedProvider() {
  const replies: ScriptedReply[] = []
  const requests: unknown[] = []
  const nativeHold = heldReply()
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/native-hold") {
        nativeHold.entered.resolve()
        await nativeHold.release.promise
        return new Response("Fixture hold released")
      }
      const body: unknown = await request.json()
      requests.push(body)
      const model = requestedModel(body)
      const scheduled = replies.shift()
      if (!scheduled)
        return new Response("No scripted reply; model access is disabled", { status: 503 })
      const calls = await resolveCalls(scheduled)
      const chunks = calls.length ? toolCallChunks(calls, requests.length) : completionChunks()
      // Requests may arrive while a held reply waits, so count them after it resolves.
      return eventStream(chunks, model, requests.length)
    },
  })
  return { provider, replies, requests, nativeHold }
}
