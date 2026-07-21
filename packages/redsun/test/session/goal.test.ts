import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LLMEvent } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { Goal, parseVerdict } from "../../src/session/goal"
import { LLM, type StreamInput } from "../../src/session/llm"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { testEffect } from "../lib/effect"

let captured: StreamInput | undefined
const llm = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      captured = input
      return Stream.fromIterable([
        LLMEvent.textStart({ id: "judge" }),
        LLMEvent.textDelta({ id: "judge", text: '{"ok":false,"reason":"more work"}' }),
        LLMEvent.textEnd({ id: "judge" }),
      ])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Goal.node, Session.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
    [[LLM.node, llm]],
  ),
)

const model = {
  id: "gpt-test",
  providerID: "openai",
  name: "Test",
  api: { npm: "@ai-sdk/openai" },
  capabilities: { attachment: false },
} as Provider.Model
const providerID = ProviderV2.ID.make("openai")
const modelID = ModelV2.ID.make("gpt-test")
const agent = {
  name: "build",
  mode: "primary",
  permission: [],
  options: {},
} as unknown as Agent.Info

describe("session goal judge", () => {
  test("parses plain and fenced JSON verdicts", () => {
    expect(parseVerdict('{"ok":true,"reason":"done"}')).toEqual({ ok: true, reason: "done" })
    expect(parseVerdict('```json\n{"ok":false,"reason":"more work"}\n```')).toEqual({
      ok: false,
      reason: "more work",
    })
  })

  it.instance("uses the provider-aware LLM request path", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID, modelID },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: session.id,
        type: "text",
        text: "finish the task",
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: session.id,
        parentID: user.id,
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID,
        providerID,
        time: { created: Date.now() },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "text",
        text: "not finished yet",
      })

      const messages = yield* sessions.messages({ sessionID: session.id })
      const verdict = yield* Goal.Service.use((goal) =>
        goal.evaluate({
          sessionID: session.id,
          condition: "finish the task",
          messages,
          model,
          agent,
        }),
      )

      expect(verdict).toEqual({ ok: false, reason: "more work" })
      expect(captured?.toolChoice).toBe("none")
      expect(captured?.tools).toEqual({})
      expect(captured?.internal).toBe(true)
      expect(captured?.agent.prompt).toContain("evaluating a stop condition")
    }),
  )
})
