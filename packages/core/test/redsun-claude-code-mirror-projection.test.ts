import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ClaudeCodeSubagentEvents } from "@opencode-ai/core/plugin/redsun/claude-code/subagent-events"
import type { ClaudeCodeSubagents } from "@opencode-ai/core/plugin/redsun/claude-code/subagents"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    [Bus.node, Bus.configured({ persist: true })],
  ]),
)

const sessionID = Session.ID.make("ses_mirror_child")
const messageID = "msg_mirror_1"
const model = { id: Model.ID.make("sonnet"), providerID: Provider.ID.make("claude-code") }
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "mirror",
      directory: "/project",
      title: "audit the config loader (@explore subagent)",
      version: "test",
    })
    .run()
  return db
})

const readMessages = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
  return rows.map((row) => decodeMessage({ id: row.id, type: row.type, ...(row.data as object) }))
})

const publish = (events: readonly ClaudeCodeSubagents.ChildEvent[]) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* ClaudeCodeSubagentEvents.publish(bus, model, events)
  })

describe("ClaudeCodeSubagentEvents", () => {
  it.effect("projects a mirrored subagent turn into real child message rows", () =>
    Effect.gen(function* () {
      yield* seed
      yield* publish([
        { kind: "execution-started", sessionID },
        { kind: "step-started", sessionID, messageID, agent: "explore" },
        { kind: "reasoning", sessionID, messageID, ordinal: 0, text: "checking the loader" },
        { kind: "text", sessionID, messageID, ordinal: 1, text: "Found it." },
        {
          kind: "tool-called",
          sessionID,
          messageID,
          id: "toolu_read",
          name: "read",
          input: { path: "/project/config.ts" },
        },
        { kind: "tool-result", sessionID, messageID, id: "toolu_read", text: "file body", failed: false },
        { kind: "step-ended", sessionID, messageID },
        { kind: "execution-succeeded", sessionID },
      ])

      const messages = yield* readMessages
      expect(messages).toHaveLength(1)
      const assistant = messages[0]
      if (assistant?.type !== "assistant") return yield* Effect.die("expected an assistant message")

      expect(String(assistant.agent)).toBe("explore")
      expect(assistant.model).toMatchObject({ providerID: "claude-code", id: "sonnet" })
      expect(assistant.finish).toBe("stop")
      expect(assistant.time.completed).toBeDefined()

      expect(assistant.content.map((part) => part.type)).toEqual(["reasoning", "text", "tool"])
      const [reasoning, text, tool] = assistant.content
      if (reasoning?.type !== "reasoning") return yield* Effect.die("expected reasoning")
      if (text?.type !== "text") return yield* Effect.die("expected text")
      if (tool?.type !== "tool") return yield* Effect.die("expected tool")

      expect(reasoning.text).toBe("checking the loader")
      expect(text.text).toBe("Found it.")
      expect(tool.name).toBe("read")
      expect(tool.executed).toBe(true)
      // The full input/output round trip is what proves the ordering contract:
      // `tool.success` is a no-op unless `tool.called` already put the part in
      // `running`.
      expect(tool.state).toMatchObject({
        status: "completed",
        input: { path: "/project/config.ts" },
        content: [{ type: "text", text: "file body" }],
      })
    }),
  )

  it.effect("projects a failed subagent tool call as an error part", () =>
    Effect.gen(function* () {
      yield* seed
      yield* publish([
        { kind: "step-started", sessionID, messageID, agent: "explore" },
        { kind: "tool-called", sessionID, messageID, id: "toolu_read", name: "read", input: {} },
        { kind: "tool-result", sessionID, messageID, id: "toolu_read", text: "no such file", failed: true },
      ])

      const messages = yield* readMessages
      const assistant = messages[0]
      if (assistant?.type !== "assistant") return yield* Effect.die("expected an assistant message")
      const tool = assistant.content[0]
      if (tool?.type !== "tool") return yield* Effect.die("expected tool")
      expect(tool.state).toMatchObject({ status: "error" })
    }),
  )

  it.effect("keeps an empty tool output projectable", () =>
    Effect.gen(function* () {
      yield* seed
      yield* publish([
        { kind: "step-started", sessionID, messageID, agent: "explore" },
        { kind: "tool-called", sessionID, messageID, id: "toolu_x", name: "shell", input: {} },
        { kind: "tool-result", sessionID, messageID, id: "toolu_x", text: "", failed: false },
      ])

      const messages = yield* readMessages
      const assistant = messages[0]
      if (assistant?.type !== "assistant") return yield* Effect.die("expected an assistant message")
      const tool = assistant.content[0]
      if (tool?.type !== "tool") return yield* Effect.die("expected tool")
      // Tool.Success.content is a NonEmptyArray; an empty output must not drop
      // the event on the floor.
      expect(tool.state).toMatchObject({ status: "completed", content: [{ type: "text", text: "(no output)" }] })
    }),
  )
})
