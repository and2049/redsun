import { expect, test } from "bun:test"
import { Message, ToolCallPart, ToolResultPart } from "@opencode-ai/ai"
import { Document, Info as ConfigInfo } from "@opencode-ai/schema/config"
import { Config } from "@opencode-ai/core/config"
import {
  RedsunContextOptimizer,
  boundInstruction,
  boundInstructionText,
  dedupeStaleReads,
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

const read = (id: string, input: Record<string, unknown>, size: number) => [
  Message.assistant([ToolCallPart.make({ id, name: "read", input })]),
  Message.make({
    role: "tool",
    content: [ToolResultPart.make({ id, name: "read", result: "x".repeat(size), resultType: "text" })],
  }),
]

const resultText = (message: Message) => {
  const part = message.content[0]
  return part?.type === "tool-result" && part.result.type === "text" ? String(part.result.value) : ""
}

const results = (messages: Array<Message>) => messages.filter((message) => message.role === "tool").map(resultText)

test("dedupeStaleReads replaces only reads superseded by a later read of the same path and range", () => {
  const messages = [
    Message.user("start"),
    ...read("a1", { path: "a.ts" }, 300),
    ...read("b1", { path: "b.ts" }, 300),
    toolMessage("shell", 300),
    ...read("a2", { path: "a.ts" }, 300),
    ...read("a3", { path: "a.ts", offset: 10 }, 300),
  ]
  const deduped = dedupeStaleReads(messages, 0)
  expect(deduped).toHaveLength(messages.length)
  expect(deduped[0]?.content[0]).toEqual({ type: "text", text: "start" })
  const [a1, b1, shell, a2, a3] = results(deduped)
  expect(a1).toBe("[redsun: superseded by a later read of a.ts; see the latest read result]")
  expect(b1).not.toContain("superseded")
  expect(shell).not.toContain("superseded")
  expect(a2).not.toContain("superseded")
  expect(a3).not.toContain("superseded")
  expect(deduped[2]?.content[0]?.type).toBe("tool-result")
})

test("dedupeStaleReads defers rewriting until the superseded results reach the threshold", () => {
  const messages = [...read("a1", { path: "a.ts" }, 600), ...read("a2", { path: "a.ts" }, 600)]
  expect(dedupeStaleReads(messages, 1_000)).toBe(messages)
  expect(results(dedupeStaleReads([...messages, ...read("a3", { path: "a.ts" }, 1_000)], 1_000))).toEqual([
    "[redsun: superseded by a later read of a.ts; see the latest read result]",
    "[redsun: superseded by a later read of a.ts; see the latest read result]",
    "x".repeat(1_000),
  ])
})

test("dedupeStaleReads is idempotent and leaves histories without stale reads untouched", () => {
  const messages = [...read("a1", { path: "a.ts" }, 300), ...read("a2", { path: "a.ts" }, 300)]
  const once = dedupeStaleReads(messages, 0)
  expect(results(dedupeStaleReads(once, 0))).toEqual(results(once))
  const distinct = [...read("a1", { path: "a.ts" }, 300), ...read("b1", { path: "b.ts" }, 300)]
  expect(dedupeStaleReads(distinct, 0)).toBe(distinct)
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
        ...read("a1", { path: "a.ts" }, 70_000),
        ...read("a2", { path: "a.ts" }, 300),
      ],
      tools: {},
    }
    yield* callback!(event as never)

    expect(event.system[0]?.text.length).toBeLessThanOrEqual(400)
    expect(event.system[0]?.text).toContain("truncated at line")
    const firstUser = event.messages[0] as Message
    const firstPart = firstUser.content[0]
    expect(firstPart?.type === "text" ? firstPart.text : "").toContain("truncated at line")
    expect(resultText(event.messages[2] as Message)).toContain("superseded by a later read of a.ts")
    expect(resultText(event.messages[4] as Message)).toBe("x".repeat(300))
  }),
)
