import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"
import type { Provider } from "../../src/provider/provider"

const model = {
  id: "model",
  providerID: "provider",
  api: { id: "model", url: "https://example.com", npm: "@ai-sdk/openai" },
} as Provider.Model

function toolPart(input: {
  status?: "completed" | "error"
  providerExecuted?: boolean
  interrupted?: boolean
  metadata?: Record<string, unknown>
} = {}): MessageV2.ToolPart {
  const base = {
    id: "part-1",
    messageID: "message-1",
    sessionID: "session-1",
    type: "tool" as const,
    callID: "call-1",
    tool: "read",
    metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
  }
  if (input.status === "error") {
    return {
      ...base,
      state: {
        status: "error",
        input: {},
        error: "failed",
        metadata: { ...input.metadata, ...(input.interrupted ? { interrupted: true } : {}) },
        time: { start: 1, end: 2 },
      },
    }
  }
  return {
    ...base,
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "Read",
      metadata: input.metadata ?? {},
      time: { start: 1, end: 2 },
    },
  }
}

function assistantWith(part: MessageV2.ToolPart): MessageV2.WithParts {
  return {
    info: {
      id: "message-1",
      sessionID: "session-1",
      parentID: "user-1",
      role: "assistant",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "model",
      providerID: "provider",
      finish: "stop",
      time: { created: 1, completed: 2 },
    },
    parts: [part],
  }
}

describe("upstream session-loop parity", () => {
  test("prompt file input infers omitted MIME types", () => {
    const parsed = SessionPrompt.PromptInput.parse({
      sessionID: "session-1",
      parts: [{ type: "file", url: "data:image/png;base64,AAAA" }],
    })
    const part = parsed.parts[0]
    expect(part.type).toBe("file")
    expect(SessionPrompt.inferFilePartMime(part as { url: string; mime?: string })).toBe("image/png")
    expect(SessionPrompt.inferFilePartMime({ url: "https://example.com/folder/" })).toBe(
      "application/x-directory",
    )
    expect(SessionPrompt.decodeDataUrlText("data:text/plain;base64,aGVsbG8=")).toBe("hello")
    expect(SessionPrompt.decodeDataUrlText("data:text/plain,hello%20world")).toBe("hello world")
  })

  test("stop finishes with model-executed tool calls keep the loop actionable", () => {
    expect(SessionPrompt.hasActionableToolCall(assistantWith(toolPart()))).toBe(true)
    expect(SessionPrompt.hasActionableToolCall(assistantWith(toolPart({ status: "error" })))).toBe(true)
    expect(SessionPrompt.hasActionableToolCall(assistantWith(toolPart({ providerExecuted: true })))).toBe(false)
    expect(SessionPrompt.hasActionableToolCall(assistantWith(toolPart({ status: "error", interrupted: true })))).toBe(false)
  })

  test("content-filter finishes become typed visible errors", () => {
    const error = SessionProcessor.errorForFinishReason("content-filter")
    expect(MessageV2.ContentFilterError.isInstance(error)).toBe(true)
    expect(error?.data.message).toBe("The response was blocked by the provider's content filter")
    expect(SessionProcessor.errorForFinishReason("stop")).toBeUndefined()
  })

  test("tool errors preserve execution metadata", () => {
    const part = toolPart({ status: "error", metadata: { sessionId: "child" } })
    expect(SessionProcessor.toolErrorMetadata(part, new Error("failed"))).toEqual({ sessionId: "child" })
  })

  test("provider-executed tools preserve metadata and raw output", () => {
    expect(SessionProcessor.toolCallMetadata({ openai: { itemId: "item-1" } }, true)).toEqual({
      openai: { itemId: "item-1" },
      providerExecuted: true,
    })
    expect(SessionProcessor.toolResultOutput("web_search", { queries: ["redsun"] })).toEqual({
      title: "web_search",
      metadata: { queries: ["redsun"] },
      output: JSON.stringify({ queries: ["redsun"] }),
      attachments: undefined,
    })

    const converted = MessageV2.toModelMessage([assistantWith(toolPart({ providerExecuted: true }))])
    expect(converted).toHaveLength(1)
    expect(converted[0].role).toBe("assistant")
    expect((converted[0] as any).content.map((part: any) => part.type)).toEqual(["tool-call", "tool-result"])
  })

  test("preserves signed reasoning separators and strips reasoning metadata after a model switch", () => {
    const message = assistantWith(toolPart())
    message.parts = [
      {
        id: "reasoning",
        messageID: message.info.id,
        sessionID: message.info.sessionID,
        type: "reasoning",
        text: "thinking",
        metadata: { anthropic: { signature: "sig" } },
        time: { start: 1, end: 2 },
      },
      {
        id: "separator",
        messageID: message.info.id,
        sessionID: message.info.sessionID,
        type: "text",
        text: "",
      },
    ]

    const sameModel = MessageV2.toModelMessage([message], model)
    const sameParts = (sameModel[0] as any).content
    expect(sameParts.find((part: any) => part.type === "text")?.text).toBe(" ")
    expect(sameParts.some((part: any) => part.type === "reasoning")).toBe(true)

    const switched = MessageV2.toModelMessage([message], { ...model, id: "other" })
    expect((switched[0] as any).content.every((part: any) => part.type === "text")).toBe(true)
  })

  test("keeps supported tool media inside the tool result without an empty text block", () => {
    const part = toolPart()
    if (part.state.status !== "completed") throw new Error("expected completed tool")
    part.state.output = ""
    part.state.attachments = [{
      id: "attachment",
      messageID: part.messageID,
      sessionID: part.sessionID,
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: "data:image/png;base64,AAAA",
    }]

    const converted = MessageV2.toModelMessage([assistantWith(part)], model)
    expect(converted.some((message) => message.role === "user")).toBe(false)
    const result = converted
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .find((item: any) => item.type === "tool-result")
    expect(result.output.type).toBe("content")
    expect(result.output.value.map((item: any) => item.type)).toEqual(["media"])
  })

  test("replays partial output from an interrupted tool", () => {
    const part = toolPart({ status: "error", interrupted: true, metadata: { output: "partial output" } })
    const converted = MessageV2.toModelMessage([assistantWith(part)], model)
    const result = converted
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .find((item: any) => item.type === "tool-result")
    expect(result.output).toEqual({ type: "text", value: "partial output" })
  })

  test("does not treat an errored compaction summary as a completed boundary", async () => {
    const compactionID = "user-compaction"
    const messages = [
      {
        info: {
          ...assistantWith(toolPart()).info,
          id: "assistant-summary",
          parentID: compactionID,
          summary: true,
          finish: "stop",
          error: new MessageV2.ContentFilterError({ message: "blocked" }).toObject(),
        },
        parts: [],
      },
      {
        info: { id: compactionID, sessionID: "session-1", role: "user", agent: "build", time: { created: 2 } },
        parts: [{ id: "compact", messageID: compactionID, sessionID: "session-1", type: "compaction", auto: true }],
      },
      {
        info: { id: "old-user", sessionID: "session-1", role: "user", agent: "build", time: { created: 1 } },
        parts: [{ id: "text", messageID: "old-user", sessionID: "session-1", type: "text", text: "keep me" }],
      },
    ] as MessageV2.WithParts[]
    async function* stream() {
      yield* messages
    }
    const filtered = await MessageV2.filterCompacted(stream())
    expect(filtered.some((message) => message.info.id === "old-user")).toBe(true)
  })

  test("content-filter finish is stored and published by the real loop", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { stream?: boolean }
        if (!body.stream) return Response.json({})
        const chunks = [
          {
            id: "chatcmpl-filter",
            object: "chat.completion.chunk",
            created: 0,
            model: "filter-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-filter",
            object: "chat.completion.chunk",
            created: 0,
            model: "filter-model",
            choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    await using tmp = await tmpdir({
      init: (dir) =>
        Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            provider: {
              "filter-test": {
                name: "Filter Test",
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url}v1`,
                options: { apiKey: "test" },
                models: {
                  "filter-model": {
                    name: "Filter Model",
                    tool_call: true,
                    limit: { context: 128000, output: 4096 },
                  },
                },
              },
            },
          }),
        ),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const errors: MessageV2.Assistant["error"][] = []
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === session.id) errors.push(event.properties.error)
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "filter-test", modelID: "filter-model" },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })

        const result = await SessionPrompt.loop(session.id)
        unsubscribe()

        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(result.info.finish).toBe("content-filter")
          expect(MessageV2.ContentFilterError.isInstance(result.info.error)).toBe(true)
        }
        expect(errors.some((error) => MessageV2.ContentFilterError.isInstance(error))).toBe(true)
        expect(result.parts.some((part) => part.type === "text" && part.text === "partial")).toBe(true)
        await Session.remove(session.id)
      },
    })
  })

  test("cancelling an active loop resolves queued callers with the same assistant", async () => {
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => (started = resolve))
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        started()
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: "chatcmpl-hang",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "hang-model",
                    choices: [{ index: 0, delta: { role: "assistant", content: "started" }, finish_reason: null }],
                  })}\n\n`,
                ),
              )
              request.signal.addEventListener("abort", () => controller.close(), { once: true })
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    await using tmp = await tmpdir({
      init: (dir) =>
        Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            provider: {
              "hang-test": {
                name: "Hang Test",
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url}v1`,
                options: { apiKey: "test" },
                models: {
                  "hang-model": {
                    name: "Hang Model",
                    tool_call: true,
                    limit: { context: 128000, output: 4096 },
                  },
                },
              },
            },
          }),
        ),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "hang-test", modelID: "hang-model" },
          noReply: true,
          parts: [{ type: "text", text: "wait" }],
        })

        const first = SessionPrompt.loop(session.id)
        await requestStarted
        for (let attempt = 0; attempt < 100; attempt++) {
          const messages = await Session.messages({ sessionID: session.id })
          if (
            messages.some(
              (message) =>
                message.info.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text),
            )
          )
            break
          await Bun.sleep(5)
        }
        const second = SessionPrompt.loop(session.id)
        SessionPrompt.cancel(session.id)
        const [a, b] = await Promise.all([first, second])

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        const text = a.parts.find((part) => part.type === "text")
        expect(text?.type === "text" ? text.time?.end : undefined).toBeNumber()
        await Session.remove(session.id)
      },
    })
  }, 10_000)

  test("steering reloads the transcript and resets the agent step allowance", async () => {
    let releaseFirst!: () => void
    const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve))
    let firstStarted!: () => void
    const firstRequest = new Promise<void>((resolve) => (firstStarted = resolve))
    const requests: Record<string, any>[] = []
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, any>
        requests.push(body)
        if (requests.length === 1) {
          firstStarted()
          await firstReleased
        }
        const content = `response-${requests.length}`
        const chunks = [
          {
            id: `chatcmpl-${requests.length}`,
            object: "chat.completion.chunk",
            created: 0,
            model: "steer-model",
            choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
          },
          {
            id: `chatcmpl-${requests.length}`,
            object: "chat.completion.chunk",
            created: 0,
            model: "steer-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    await using tmp = await tmpdir({
      init: (dir) =>
        Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            agent: { build: { maxSteps: 2 } },
            provider: {
              "steer-test": {
                name: "Steer Test",
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url}v1`,
                options: { apiKey: "test" },
                models: {
                  "steer-model": {
                    name: "Steer Model",
                    tool_call: true,
                    limit: { context: 128000, output: 4096 },
                  },
                },
              },
            },
          }),
        ),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Steering test" })
        const user = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "steer-test", modelID: "steer-model" },
          noReply: true,
          parts: [{ type: "text", text: "first request" }],
        })
        if (user.info.role === "user") {
          user.info.summary = { title: "First request", diffs: [] }
          await Session.updateMessage(user.info)
        }

        let summaries = 0
        const unsubscribe = Bus.subscribe(Session.Event.Diff, (event) => {
          if (event.properties.sessionID === session.id) summaries++
        })
        const running = SessionPrompt.loop(session.id)
        await firstRequest
        const queued = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "steer-test", modelID: "steer-model" },
          parts: [{ type: "text", text: "second request" }],
        })
        while (true) {
          const users = (await Session.messages({ sessionID: session.id })).filter(
            (message) => message.info.role === "user",
          )
          if (users.length >= 2) {
            const second = users.at(-1)!
            if (second.info.role === "user") {
              second.info.summary = { title: "Second request", diffs: [] }
              await Session.updateMessage(second.info)
            }
            break
          }
          await Bun.sleep(1)
        }
        releaseFirst()
        await Promise.all([running, queued])

        const mainRequests = requests.filter(
          (request) => !JSON.stringify(request).includes("The following is the text to summarize"),
        )
        expect(mainRequests).toHaveLength(2)
        expect(JSON.stringify(mainRequests[1])).toContain("second request")
        expect(JSON.stringify(mainRequests[1])).not.toContain("MAXIMUM STEPS REACHED")
        while (summaries < 2) await Bun.sleep(1)
        await Bun.sleep(50)
        unsubscribe()
        await Session.remove(session.id)
      },
    })
  }, 10_000)

  test("cancelling before processor creation finalizes an aborted assistant", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = (await Session.updateMessage({
          id: "msg_01K00000000000000000000000",
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "never-resolved", modelID: "never-resolved" },
        })) as MessageV2.User
        await Session.updatePart({
          id: "prt_01K00000000000000000000000",
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "stop immediately",
        })

        const first = SessionPrompt.loop(session.id)
        const second = SessionPrompt.loop(session.id)
        while (true) {
          try {
            SessionPrompt.assertNotBusy(session.id)
            await Bun.sleep(0)
          } catch {
            break
          }
        }
        SessionPrompt.cancel(session.id)
        const [a, b] = await Promise.all([first, second])

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        expect(a.parts).toHaveLength(0)
        if (a.info.role === "assistant") {
          expect(a.info.parentID).toBe(user.id)
          expect(a.info.time.completed).toBeNumber()
          expect(MessageV2.AbortedError.isInstance(a.info.error)).toBe(true)
          expect(a.info.finish).toBeUndefined()
        }

        const messages = await Session.messages({ sessionID: session.id })
        const unfinished = messages.filter(
          (message) =>
            message.info.role === "assistant" &&
            !message.info.time.completed &&
            !message.info.error &&
            !message.info.finish,
        )
        expect(unfinished).toHaveLength(0)
        await Session.remove(session.id)
      },
    })
  })

  test("invalid prompt agents fail with an actionable error", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            agent: "missing-agent",
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          }),
        ).rejects.toThrow("Unknown agent: missing-agent")
        await Session.remove(session.id)
      },
    })
  })
})
