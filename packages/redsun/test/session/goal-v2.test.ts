import { describe, expect } from "bun:test"
import { LLMClient, LLMError, LLMEvent, LLMResponse, Message, Model, TransportReason } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionContinuationPolicy } from "@opencode-ai/core/session/continuation-policy"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Fiber, Layer } from "effect"
import * as Stream from "effect/Stream"
import { GoalV2 } from "../../src/session/goal-v2"
import { REACT_CAP } from "../../src/session/goal-shared"
import { testEffect } from "../lib/effect"

let judgeText = '{"ok":false,"reason":"more work"}'
let judgeFailure: LLMError | undefined
const judgeResponse = () =>
  new LLMResponse({
    message: Message.assistant(judgeText),
    events: [
      LLMEvent.textStart({ id: "judge" }),
      LLMEvent.textDelta({ id: "judge", text: judgeText }),
      LLMEvent.textEnd({ id: "judge" }),
    ],
    finishReason: "stop",
  })
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () => Stream.die("unused"),
    generate: () => (judgeFailure ? Effect.fail(judgeFailure) : Effect.sync(judgeResponse)),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const sessionID = SessionV2.ID.make("ses_goal_v2_test")
const sessionInfo = { id: sessionID } as unknown as SessionSchema.Info
const store = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(sessionInfo),
  context: () => Effect.succeed([]),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([GoalV2.policyNode, SessionProjector.node, Database.node, EventV2.node]), [
    [LayerNodePlatform.llmClient, client],
    [SessionRunnerModel.node, models],
    [SessionStore.node, store],
  ]),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  judgeText = '{"ok":false,"reason":"more work"}'
  judgeFailure = undefined
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const goalRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows.filter((row) => row.type.startsWith("redsun.session.goal"))
})

const onSettle = Effect.gen(function* () {
  const policy = yield* SessionContinuationPolicy.Service
  yield* policy.onSettle({ sessionID })
})

describe("GoalV2", () => {
  it.effect("folds set, verdict, and cleared events into goal state", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const mirrored = yield* events
        .subscribe(SessionV1.Event.GoalUpdated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* GoalV2.set(events, { sessionID, condition: "finish the task" })

      const afterSet = yield* GoalV2.get(db, sessionID)
      expect(afterSet).toMatchObject({ condition: "finish the task", attempts: 0 })

      yield* GoalV2.recordVerdict(events, {
        sessionID,
        condition: "finish the task",
        verdict: { ok: false, reason: "keep going" },
        attempt: 2,
      })
      const afterVerdict = yield* GoalV2.get(db, sessionID)
      expect(afterVerdict).toMatchObject({
        condition: "finish the task",
        attempts: 2,
        lastVerdict: { ok: false, reason: "keep going", attempt: 2 },
      })

      yield* GoalV2.clear(events, { sessionID, reason: "manual" })
      expect(yield* GoalV2.get(db, sessionID)).toBeUndefined()

      const received = Array.from(yield* Fiber.join(mirrored))
      expect((received[0] as { data: unknown }).data).toEqual({
        sessionID,
        goal: { condition: "finish the task" },
      })
    }),
  )

  it.effect("admits a steering continuation when the goal is unsatisfied", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass" })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      const state = yield* GoalV2.get(db, sessionID)
      expect(state).toMatchObject({
        condition: "all tests pass",
        attempts: 1,
        lastVerdict: { ok: false, reason: "more work", attempt: 1 },
      })
    }),
  )

  it.effect("clears the goal and admits nothing when satisfied", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      judgeText = '{"ok":true,"reason":"done"}'
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass" })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
      expect(yield* GoalV2.get(db, sessionID)).toBeUndefined()
      const rows = yield* goalRows
      expect(rows.map((row) => row.type.split(".").slice(0, 4).join("."))).toEqual([
        "redsun.session.goal.set",
        "redsun.session.goal.verdict",
        "redsun.session.goal.cleared",
      ])
      expect(rows[2]?.data).toMatchObject({ reason: "satisfied" })
    }),
  )

  it.effect("keeps the goal and stops when the judge fails", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      judgeFailure = new LLMError({
        module: "test",
        method: "generate",
        reason: new TransportReason({ message: "judge unavailable" }),
      })
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass" })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
      const state = yield* GoalV2.get(db, sessionID)
      expect(state).toMatchObject({ condition: "all tests pass" })
      expect(state?.lastVerdict).toMatchObject({ ok: false, error: true })
    }),
  )

  it.effect("stops without judging when the wall-clock budget is exhausted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      judgeText = '{"ok":false,"reason":"should never be asked"}'
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass", budget: { wallClockMs: 0 } })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
      expect(yield* GoalV2.get(db, sessionID)).toBeUndefined()
      const rows = yield* goalRows
      expect(rows.at(-2)?.data).toMatchObject({ ok: false })
      expect(String((rows.at(-2)?.data as { reason?: string }).reason)).toContain("wall-clock budget exhausted")
      expect(rows.at(-1)?.data).toMatchObject({ reason: "capped" })
    }),
  )

  it.effect("stops when the token budget is exhausted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass", budget: { tokens: 100 } })
      yield* events.publish(SessionEvent.Step.Ended, {
        timestamp: yield* DateTime.now,
        sessionID,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: 0,
        tokens: { input: 80, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
      expect(yield* GoalV2.get(db, sessionID)).toBeUndefined()
      const rows = yield* goalRows
      expect(String((rows.at(-2)?.data as { reason?: string }).reason)).toContain("token budget exhausted")
      expect(rows.at(-1)?.data).toMatchObject({ reason: "capped" })
    }),
  )

  it.effect("keeps judging while the token budget has headroom", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass", budget: { tokens: 1_000_000 } })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(yield* GoalV2.get(db, sessionID)).toMatchObject({ attempts: 1 })
    }),
  )

  it.effect("caps continuation attempts and clears the goal", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* GoalV2.set(events, { sessionID, condition: "all tests pass" })
      yield* GoalV2.recordVerdict(events, {
        sessionID,
        condition: "all tests pass",
        verdict: { ok: false, reason: "still going" },
        attempt: REACT_CAP,
      })

      yield* onSettle

      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
      expect(yield* GoalV2.get(db, sessionID)).toBeUndefined()
      const rows = yield* goalRows
      expect(rows.at(-1)?.data).toMatchObject({ reason: "capped" })
    }),
  )
})
