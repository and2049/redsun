import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, LLMResponse, Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config as ConfigV2 } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, type LayerMap } from "effect"
import * as Stream from "effect/Stream"
import { Advisor, parseAdvisory } from "../../src/advisor/advisor"
import { testEffect } from "../lib/effect"

let judgeText = '{"severity":"none"}'
const judgeResponse = () =>
  new LLMResponse({
    message: Message.assistant(judgeText),
    events: [
      LLMEvent.textStart({ id: "advisor" }),
      LLMEvent.textDelta({ id: "advisor", text: judgeText }),
      LLMEvent.textEnd({ id: "advisor" }),
    ],
    finishReason: "stop",
  })
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () => Stream.die("unused"),
    generate: () => Effect.sync(judgeResponse),
  }),
)
const model = Model.make({ id: "advisor-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
let advisorConfig: ConfigV2.Info["advisor"] | undefined
const configV2 = Layer.succeed(
  ConfigV2.Service,
  ConfigV2.Service.of({
    entries: () =>
      Effect.sync(() => [
        new ConfigV2.Document({
          type: "document",
          info: new ConfigV2.Info(advisorConfig === undefined ? {} : { advisor: advisorConfig }),
        }),
      ]),
  }),
)
const located = Layer.mergeAll(models, configV2)
const locations = Layer.succeed(
  LocationServiceMap.Service,
  { get: () => located } as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>,
)

const sessionID = "ses_advisor_test" as SessionSchema.ID
const sessionInfo = {
  id: sessionID,
  location: { directory: AbsolutePath.make("/project") },
} as unknown as SessionSchema.Info
const userMessage = {
  id: SessionMessage.ID.create(),
  sessionID,
  type: "user",
  text: "build the feature",
} as unknown as SessionMessage.Message
const store = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(sessionInfo),
  context: () => Effect.succeed([userMessage]),
})

const prompts: { sessionID: string; text: string; delivery?: string }[] = []
const admittedIDs: SessionMessage.ID[] = []
const sessions = Layer.mock(SessionV2.Service, {
  revert: {
    stage: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    commit: () => Effect.die("unused"),
  },
  prompt: (input) =>
    Effect.gen(function* () {
      prompts.push({
        sessionID: input.sessionID,
        text: typeof input.prompt === "string" ? input.prompt : (input.prompt.text ?? ""),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      })
      const id = input.id ?? SessionMessage.ID.create()
      admittedIDs.push(id)
      return SessionInput.Admitted.make({
        admittedSeq: prompts.length,
        id,
        sessionID: input.sessionID,
        prompt: Prompt.make({ text: typeof input.prompt === "string" ? input.prompt : (input.prompt.text ?? "") }),
        delivery: input.delivery ?? "steer",
        timeCreated: yield* DateTime.now,
      })
    }),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Advisor.node, Database.node, EventV2.node]), [
    [LayerNodePlatform.llmClient, client],
    [SessionStore.node, store],
    [SessionV2.node, sessions],
    [LocationServiceMap.node, locations],
  ]),
)

const setup = Effect.sync(() => {
  judgeText = '{"severity":"none"}'
  advisorConfig = { enabled: true }
  prompts.length = 0
  admittedIDs.length = 0
})

const advisoryRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows.filter((row) => row.type.startsWith("redsun.session.advisory"))
})

const syntheticRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  return rows.filter((row) => row.type.startsWith("session.next.synthetic"))
})

const review = (promptMessageID = SessionMessage.ID.create()) =>
  Advisor.Service.use((advisor) => advisor.review({ sessionID, promptMessageID }))

describe("Advisor", () => {
  it.effect("parses fenced and plain advisories", () =>
    Effect.sync(() => {
      expect(parseAdvisory('{"severity":"none"}')).toEqual({ severity: "none" })
      expect(parseAdvisory('```json\n{"severity":"aside","note":"check tests"}\n```')).toEqual({
        severity: "aside",
        note: "check tests",
      })
    }),
  )

  it.effect("does nothing while disabled", () =>
    Effect.gen(function* () {
      yield* setup
      advisorConfig = undefined
      judgeText = '{"severity":"interrupt","note":"stop"}'
      yield* review()
      expect(yield* advisoryRows).toHaveLength(0)
      expect(prompts).toHaveLength(0)
    }),
  )

  it.effect("stays silent on a none verdict", () =>
    Effect.gen(function* () {
      yield* setup
      yield* review()
      expect(yield* advisoryRows).toHaveLength(0)
      expect(yield* syntheticRows).toHaveLength(0)
      expect(prompts).toHaveLength(0)
    }),
  )

  it.effect("records an aside as a durable synthetic message without waking the session", () =>
    Effect.gen(function* () {
      yield* setup
      judgeText = '{"severity":"aside","note":"remember to run the tests"}'
      yield* review()
      const advisories = yield* advisoryRows
      expect(advisories).toHaveLength(1)
      expect(advisories[0]?.data).toMatchObject({ severity: "aside", note: "remember to run the tests" })
      const synthetic = yield* syntheticRows
      expect(synthetic).toHaveLength(1)
      expect((synthetic[0]?.data as { text?: string }).text).toBe("[advisor] remember to run the tests")
      expect(prompts).toHaveLength(0)
    }),
  )

  it.effect("interrupts with a steering prompt and does not review its own settlement", () =>
    Effect.gen(function* () {
      yield* setup
      advisorConfig = { enabled: true, cooldownTurns: 0 }
      judgeText = '{"severity":"interrupt","note":"you are deleting the wrong directory"}'
      yield* review()
      expect(prompts).toEqual([
        { sessionID, text: "[advisor] you are deleting the wrong directory", delivery: "steer" },
      ])
      const advisories = yield* advisoryRows
      expect(advisories).toHaveLength(1)
      expect(advisories[0]?.data).toMatchObject({ severity: "interrupt" })

      // The settlement of the advisor's own steering prompt must not trigger another review.
      yield* review(admittedIDs[0]!)
      expect(yield* advisoryRows).toHaveLength(1)
      expect(prompts).toHaveLength(1)
    }),
  )

  it.effect("skips reviews while a session is on cooldown", () =>
    Effect.gen(function* () {
      yield* setup
      advisorConfig = { enabled: true, cooldownTurns: 1 }
      judgeText = '{"severity":"aside","note":"first advisory"}'
      yield* review()
      expect(yield* advisoryRows).toHaveLength(1)

      judgeText = '{"severity":"aside","note":"second advisory"}'
      yield* review()
      expect(yield* advisoryRows).toHaveLength(1)

      yield* review()
      expect(yield* advisoryRows).toHaveLength(2)
    }),
  )

  it.effect("downgrades interrupts to asides in aside-only mode", () =>
    Effect.gen(function* () {
      yield* setup
      advisorConfig = { enabled: true, mode: "aside-only" }
      judgeText = '{"severity":"interrupt","note":"serious problem"}'
      yield* review()
      const advisories = yield* advisoryRows
      expect(advisories).toHaveLength(1)
      expect(advisories[0]?.data).toMatchObject({ severity: "aside" })
      expect(prompts).toHaveLength(0)
      expect(yield* syntheticRows).toHaveLength(1)
    }),
  )
})
