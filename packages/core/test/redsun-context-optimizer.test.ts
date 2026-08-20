import { expect, test } from "bun:test"
import { Message, ToolResultPart } from "@opencode-ai/ai"
import { Document, Info as ConfigInfo } from "@opencode-ai/schema/config"
import { Config } from "@opencode-ai/core/config"
import {
  RedsunContextOptimizer,
  boundInstruction,
  boundInstructionText,
  limitToolResultReplay,
} from "@opencode-ai/core/plugin/redsun/context-optimizer"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)
const decodeConfig = Schema.decodeUnknownSync(ConfigInfo)

const toolMessage = (id: string, size: number) =>
  Message.make({
    role: "tool",
    content: [ToolResultPart.make({ id, name: "shell", result: "x".repeat(size), resultType: "text" })],
  })

const resultText = (message: Message) => {
  const part = message.content[0]
  return part?.type === "tool-result" && part.result.type === "text" ? String(part.result.value) : ""
}

test("limitToolResultReplay keeps the newest results and replaces older ones in place", () => {
  const messages = [
    Message.user("start"),
    ...Array.from({ length: 10 }, (_, index) => toolMessage(`call_${index}`, 300)),
  ]
  const limited = limitToolResultReplay(messages, 1_000, 2)
  // Order and pairing intact: nothing removed, first message untouched.
  expect(limited).toHaveLength(11)
  expect(limited[0]?.content[0]).toEqual({ type: "text", text: "start" })
  // Newest two kept unconditionally; the budget covers roughly one more.
  expect(resultText(limited[10]!)).not.toContain("omitted")
  expect(resultText(limited[9]!)).not.toContain("omitted")
  const omitted = limited.slice(1).filter((message) => resultText(message).includes("omitted"))
  expect(omitted.length).toBeGreaterThanOrEqual(6)
  expect(resultText(limited[1]!)).toContain("[redsun: older tool result omitted from model context]")
  expect(resultText(limited[1]!)).toContain("tool_call: call_0")
})

test("limitToolResultReplay counts dropped sizes against the budget", () => {
  // One huge old result poisons the remaining budget: everything older than the
  // unconditional keep window is omitted even though it would individually fit.
  const messages = [toolMessage("old_small", 100), toolMessage("huge", 5_000), toolMessage("new", 100)]
  const limited = limitToolResultReplay(messages, 1_000, 1)
  expect(resultText(limited[2]!)).not.toContain("omitted")
  expect(resultText(limited[1]!)).toContain("omitted")
  expect(resultText(limited[0]!)).toContain("omitted")
})

test("limitToolResultReplay is idempotent", () => {
  const messages = [...Array.from({ length: 10 }, (_, index) => toolMessage(`call_${index}`, 300))]
  const once = limitToolResultReplay(messages, 1_000, 2)
  const twice = limitToolResultReplay(once, 1_000, 2)
  expect(twice.map(resultText)).toEqual(once.map(resultText))
})

test("boundInstruction fits or truncates at a line boundary under the cap", () => {
  expect(boundInstruction("AGENTS.md", "short file")).toBe("Instructions from: AGENTS.md\nshort file")

  const lines = Array.from({ length: 200 }, (_, index) => `line ${index} ${"pad".repeat(20)}`)
  const bounded = boundInstruction("C:\\repo\\AGENTS.md", lines.join("\n"), 2_000)
  expect(bounded.length).toBeLessThanOrEqual(2_000)
  expect(bounded).toContain("[redsun: instructions truncated at line ")
  expect(bounded).toContain("of 200 (2000 char limit)")
  const keptLines = Number(bounded.match(/truncated at line (\d+)/)?.[1])
  expect(bounded).toContain(`Read the remainder with the read tool: C:\\repo\\AGENTS.md offset=${keptLines + 1}.`)
  // The cut lands on a line boundary: the last kept line is complete.
  expect(bounded.split("\n").at(-2)).toMatch(/^line \d+ (pad)+$/)
})

test("boundInstruction points URLs at the source instead of the read tool", () => {
  const bounded = boundInstruction("https://example.com/rules", "x\n".repeat(2_000), 500)
  expect(bounded.length).toBeLessThanOrEqual(500)
  expect(bounded).toContain("Full content: https://example.com/rules")
  expect(bounded).not.toContain("read tool")
})

test("boundInstructionText bounds each block and leaves other text alone", () => {
  const big = Array.from({ length: 500 }, (_, index) => `rule ${index}`).join("\n")
  const text = [`Instructions from: A.md\n${big}`, `Instructions from: B.md\nsmall`].join("\n\n")
  const bounded = boundInstructionText(text, 1_000)
  expect(bounded).toContain("Instructions from: A.md")
  expect(bounded).toContain("truncated at line")
  expect(bounded).toContain("Instructions from: B.md\nsmall")
  expect(boundInstructionText("no instructions here", 1_000)).toBe("no instructions here")
  // Second pass is a no-op.
  expect(boundInstructionText(bounded, 1_000)).toBe(bounded)
})

it.effect("the plugin's context hook bounds instructions and tool replay through the real entry point", () =>
  Effect.gen(function* () {
    const hooks: Record<string, (event: never) => Effect.Effect<unknown, unknown, never>> = {}
    const config = Layer.mock(Config.Service)({
      entries: () =>
        Effect.succeed([new Document({ type: "document", info: decodeConfig({ instruction_max_chars: 400 }) })]),
    })
    yield* RedsunContextOptimizer.Plugin.effect(
      host({
        session: {
          hook: ((name: string, callback: (event: never) => Effect.Effect<unknown, unknown, never>) => {
            hooks[name] = callback
            return Effect.void
          }) as never,
        },
      }),
    ).pipe(Effect.provide(config))
    const callback = hooks["context"]
    expect(callback).toBeDefined()

    const big = Array.from({ length: 100 }, (_, index) => `rule ${index}`).join("\n")
    const event = {
      system: [{ type: "text", text: `Instructions from: AGENTS.md\n${big}` }],
      messages: [
        Message.user(`Instructions from: memory.md\n${big}`),
        ...Array.from({ length: 10 }, (_, index) => toolMessage(`call_${index}`, 30_000)),
      ],
      tools: {},
    }
    yield* callback!(event as never)

    expect(event.system[0]?.text.length).toBeLessThanOrEqual(400)
    expect(event.system[0]?.text).toContain("truncated at line")
    const firstUser = event.messages[0] as Message
    const firstPart = firstUser.content[0]
    expect(firstPart?.type === "text" ? firstPart.text : "").toContain("truncated at line")
    expect(resultText(event.messages[1] as Message)).toContain("omitted")
    expect(resultText(event.messages[10] as Message)).not.toContain("omitted")
  }),
)
