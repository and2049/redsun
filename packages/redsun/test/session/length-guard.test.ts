import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { lengthGuardMiddleware } from "../../src/session/llm/length-guard"

function textPart(text: string): LanguageModelV3StreamPart {
  return { type: "text-delta", id: "txt_1", delta: text } as LanguageModelV3StreamPart
}

function toolCallPart(id: string): LanguageModelV3StreamPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "bash",
    input: "{}",
  } as LanguageModelV3StreamPart
}

function finishPart(unified: string): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as unknown as LanguageModelV3StreamPart
}

async function run(guard: { hit: boolean } | undefined, parts: LanguageModelV3StreamPart[]) {
  const middleware = lengthGuardMiddleware(guard)
  const doStream = async () => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      },
    }),
  })
  const result = await middleware.wrapStream!({ doStream } as never)
  const seen: LanguageModelV3StreamPart[] = []
  const reader = (result.stream as ReadableStream<LanguageModelV3StreamPart>).getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    seen.push(value)
  }
  return seen
}

describe("lengthGuardMiddleware", () => {
  test("sets the guard before flushing tool calls on finishReason length", async () => {
    const guard = { hit: false }
    const parts = [textPart("hello"), toolCallPart("call_1"), finishPart("length")]
    const seen = await run(guard, parts)

    expect(guard.hit).toBe(true)
    // tool-call is held back until finish is known: order is text, tool-call, finish
    expect(seen.map((part) => part.type)).toEqual(["text-delta", "tool-call", "finish"])
  })

  test("does not set the guard on a normal stop", async () => {
    const guard = { hit: false }
    const seen = await run(guard, [textPart("hello"), toolCallPart("call_1"), finishPart("tool-calls")])
    expect(guard.hit).toBe(false)
    expect(seen.map((part) => part.type)).toEqual(["text-delta", "tool-call", "finish"])
  })

  test("text deltas are not held back behind buffered tool calls", async () => {
    const guard = { hit: false }
    const seen = await run(guard, [toolCallPart("call_1"), textPart("after"), finishPart("stop")])
    // the text delta emitted after the tool call must come out first
    expect(seen.map((part) => part.type)).toEqual(["text-delta", "tool-call", "finish"])
  })

  test("flushes buffered tool calls when the stream ends without a finish part", async () => {
    const guard = { hit: false }
    const seen = await run(guard, [toolCallPart("call_1")])
    expect(seen.map((part) => part.type)).toEqual(["tool-call"])
    expect(guard.hit).toBe(false)
  })

  test("passes the stream through untouched without a guard", async () => {
    const seen = await run(undefined, [toolCallPart("call_1"), finishPart("length")])
    expect(seen.map((part) => part.type)).toEqual(["tool-call", "finish"])
  })
})
