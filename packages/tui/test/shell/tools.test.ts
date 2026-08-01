import { afterEach, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { SyntaxStyle } from "@opentui/core"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { toolRunWriter, toolWriter, type ToolWriterContext } from "../../src/shell/transcript/tools"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"

const active: TestRenderer[] = []
const styles: SyntaxStyle[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) {
    renderer.destroy()
  }
  for (const style of styles.splice(0)) {
    style.destroy()
  }
})

async function setup() {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
  styles.push(syntaxStyle)

  const ctx: ToolWriterContext = {
    theme: resolveTheme(DEFAULT_THEMES.cursor, "dark"),
    syntax: syntaxStyle,
    formatPath: (input) => input ?? "",
    normalizePath: (input) => input,
    diffWrapMode: "word",
  }

  return { renderer: out.renderer, external: out.externalOutput, ctx }
}

function completed(tool: string, input: Record<string, unknown>, extra?: Partial<Record<string, unknown>>): ToolPart {
  return {
    id: "p-1",
    sessionID: "s1",
    messageID: "m-1",
    type: "tool",
    callID: "c-1",
    tool,
    state: {
      status: "completed",
      input,
      output: "",
      title: "title",
      metadata: {},
      time: { start: 1, end: 2 },
      ...extra,
    },
  } as ToolPart
}

function errored(tool: string, input: Record<string, unknown>, error: string): ToolPart {
  return {
    id: "p-1",
    sessionID: "s1",
    messageID: "m-1",
    type: "tool",
    callID: "c-1",
    tool,
    state: { status: "error", input, error, time: { start: 1, end: 2 } },
  } as ToolPart
}

test("bash records command, gutter output, and collapse", async () => {
  const out = await setup()

  out.renderer.writeToScrollback(
    toolWriter({
      part: completed("bash", { command: "ls -la" }, { metadata: { output: "file-a\nfile-b" } }),
      ctx: out.ctx,
    }),
  )
  let text = out.external.takeText()
  expect(text).toContain("⏺ Bash(ls -la)")
  expect(text).toContain("⎿")
  expect(text).toContain("file-a")
  expect(text).toContain("file-b")

  const long = Array.from({ length: 14 }, (_, index) => `line-${index}`).join("\n")
  out.renderer.writeToScrollback(
    toolWriter({
      part: completed("bash", { command: "seq" }, { metadata: { output: long } }),
      ctx: out.ctx,
    }),
  )
  text = out.external.takeText()
  expect(text).toContain("line-9")
  expect(text).not.toContain("line-10")
  expect(text).toContain("…")

  out.renderer.writeToScrollback(
    toolWriter({ part: completed("bash", { command: "true" }), ctx: out.ctx }),
  )
  expect(out.external.takeText()).toContain("(no output)")
})

test("edit commits a unified diff under the gutter", async () => {
  const out = await setup()
  const diff = [
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,2 +1,2 @@",
    "-const value = 1",
    "+const value = 2",
    " const keep = 3",
    "",
  ].join("\n")

  out.renderer.writeToScrollback(
    toolWriter({
      part: completed("edit", { filePath: "foo.ts" }, { metadata: { diff } }),
      ctx: out.ctx,
    }),
  )

  const text = out.external.takeText()
  expect(text).toContain("⏺ Edit(foo.ts)")
  expect(text).toContain("const value = 2")
  expect(text).toContain("const value = 1")
})

test("todos render dense status glyphs", async () => {
  const out = await setup()
  out.renderer.writeToScrollback(
    toolWriter({
      part: completed("todowrite", {
        todos: [
          { status: "completed", content: "done thing" },
          { status: "in_progress", content: "current thing" },
          { status: "pending", content: "next thing" },
        ],
      }),
      ctx: out.ctx,
    }),
  )

  const text = out.external.takeText()
  expect(text).toContain("⏺ Todos")
  expect(text).toContain("[✓] done thing")
  expect(text).toContain("[•] current thing")
  expect(text).toContain("[ ] next thing")
})

test("question records answers; task records subagent detail", async () => {
  const out = await setup()

  out.renderer.writeToScrollback(
    toolWriter({
      part: completed(
        "question",
        { questions: [{ question: "Which db?" }, { question: "Which port?" }] },
        { metadata: { answers: [["postgres"], []] } },
      ),
      ctx: out.ctx,
    }),
  )
  let text = out.external.takeText()
  expect(text).toContain("⏺ Question(2 questions)")
  expect(text).toContain("Which db?")
  expect(text).toContain("postgres")
  expect(text).toContain("(no answer)")

  out.renderer.writeToScrollback(
    toolWriter({
      part: completed(
        "task",
        { description: "update docs", subagent_type: "general" },
        { metadata: { sessionId: "child" } },
      ),
      ctx: out.ctx,
      task: { toolcalls: 3, durationMs: 2200 },
    }),
  )
  text = out.external.takeText()
  expect(text).toContain("⏺ Task(update docs)")
  expect(text).toContain("General")
  expect(text).toContain("3 toolcalls")
})

test("errored tools show the error in the gutter", async () => {
  const out = await setup()
  out.renderer.writeToScrollback(
    toolWriter({ part: errored("webfetch", { url: "https://example.com" }, "connection refused"), ctx: out.ctx }),
  )

  const text = out.external.takeText()
  expect(text).toContain("⏺ WebFetch(https://example.com)")
  expect(text).toContain("connection refused")
})

test("read runs merge into one explored record", async () => {
  const out = await setup()
  const parts: ToolPart[] = [
    { ...completed("read", { filePath: "src/a.ts" }), id: "p-1" } as ToolPart,
    { ...completed("read", { filePath: "src/b.ts" }), id: "p-2" } as ToolPart,
    {
      ...completed("grep", { pattern: "needle" }, { metadata: { matches: 4 } }),
      id: "p-3",
    } as ToolPart,
  ]

  out.renderer.writeToScrollback(toolRunWriter({ parts, ctx: out.ctx }))
  const text = out.external.takeText()
  expect(text).toContain("⏺ Explored(2 reads · 1 grep)")
  expect(text).toContain("Read src/a.ts")
  expect(text).toContain("Read src/b.ts")
  expect(text).toContain("Grep needle (4 matches)")

  // A single-item run renders as the plain per-tool record.
  out.renderer.writeToScrollback(toolRunWriter({ parts: [parts[0]], ctx: out.ctx }))
  expect(out.external.takeText()).toContain("⏺ Read(src/a.ts)")
})
