import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("algorithmic compaction creates a bounded structured summary without an LLM", () => {
  const summary = SessionCompaction.algorithmicSummary({
    head: "[User]: fix the cache\n[Assistant]: updated cache.ts\n[Assistant tool call]: edit(cache.ts)\n[Tool error]: first attempt failed",
  })

  expect(summary).toContain("## Objective\n- fix the cache")
  expect(summary).toContain("- updated cache.ts")
  expect(summary).toContain("- first attempt failed")
})

test("v2 inventory preserves requirements, touched files, tool results, and failures", () => {
  const timestamp = DateTime.makeUnsafe(1)
  const messages: SessionMessage.Message[] = [
    { id: SessionMessage.ID.make("msg_user"), type: "user", text: "Fix caching", time: { created: timestamp } },
    { id: SessionMessage.ID.make("msg_requirement"), type: "user", text: "Keep the API stable", time: { created: timestamp } },
    {
      id: SessionMessage.ID.make("msg_assistant"),
      type: "assistant",
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("model") },
      time: { created: timestamp, completed: timestamp },
      content: [
        { type: "text", id: "text", text: "Updated the cache implementation." },
        {
          type: "tool",
          id: "tool",
          name: "edit",
          time: { created: timestamp, completed: timestamp },
          state: {
            status: "completed",
            input: { filePath: "src/cache.ts" },
            content: [{ type: "text", text: "cache updated" }],
            outputPaths: ["src/cache.ts"],
            structured: {},
          },
        },
        {
          type: "tool",
          id: "failed-tool",
          name: "grep",
          time: { created: timestamp, completed: timestamp },
          state: {
            status: "error",
            input: { path: "src" },
            content: [],
            structured: {},
            error: { type: "unknown", message: "pattern failed" },
          },
        },
      ],
    },
  ]
  const inventory = SessionCompaction.serializeInventory(SessionCompaction.extractInventory(messages, 30))

  expect(inventory).toContain("## Task\n\nFix caching")
  expect(inventory).toContain("## User Requirements\n\n- Keep the API stable")
  expect(inventory).toContain("- `src/cache.ts`: changed")
  expect(inventory).toContain("- edit: cache updated")
  expect(inventory).toContain("- pattern failed")
})
