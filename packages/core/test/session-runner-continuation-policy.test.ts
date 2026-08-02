import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionContinuationPolicy } from "@opencode-ai/core/session/continuation-policy"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { Location } from "@opencode-ai/core/location"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const events = Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate!)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)

const settleCalls: string[] = []
let continuationTexts: string[] = []
const policyLayer = Layer.effect(
  SessionContinuationPolicy.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return SessionContinuationPolicy.Service.of({
      onSettle: ({ sessionID }) =>
        Effect.gen(function* () {
          settleCalls.push(sessionID)
          const text = continuationTexts.shift()
          if (text === undefined) return
          yield* SessionInput.admit(db, events, {
            id: SessionMessage.ID.create(),
            sessionID,
            prompt: Prompt.make({ text }),
            delivery: "steer",
          })
        }).pipe(Effect.orDie),
    })
  }),
)
const policyNode = makeLocationNode({
  service: SessionContinuationPolicy.Service,
  layer: policyLayer,
  deps: [Database.node, EventV2.node],
})

const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
  [SessionContinuationPolicy.node, policyNode],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionContinuationPolicy.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [SessionContinuationPolicy.node, policyNode],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_policy_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  requests.length = 0
  response = []
  responses = undefined
  streamGate = undefined
  streamStarted = undefined
  settleCalls.length = 0
  continuationTexts = []
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

const textResponse = (id: string, text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const readRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
})

const settledRows = readRows.pipe(
  Effect.map((rows) => rows.filter((row) => row.type.startsWith("session.next.settled"))),
)

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user" ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )

describe("session runner continuation policy", () => {
  it.effect("consults the policy once when a drain settles", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textResponse("policy-settle", "Done")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Work" }), resume: false })
      yield* session.resume(sessionID)

      expect(settleCalls).toEqual([sessionID])
      const settled = yield* settledRows
      expect(settled).toHaveLength(1)
      expect(settled[0]?.data).toMatchObject({ outcome: "completed" })
    }),
  )

  it.effect("skips the policy while queued input is pending", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = [textResponse("policy-queue-1", "One"), textResponse("policy-queue-2", "Two")]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), delivery: "queue", resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const settled = yield* settledRows
      expect(settled).toHaveLength(2)
      expect(settleCalls).toEqual([sessionID])
    }),
  )

  it.effect("extends the drain when the policy admits steering input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = [textResponse("policy-extend-1", "One"), textResponse("policy-extend-2", "Two")]
      continuationTexts = ["Keep going"]
      const admitted = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toContain("Keep going")
      expect(settleCalls).toEqual([sessionID, sessionID])
      const settled = yield* settledRows
      expect(settled).toHaveLength(1)
      expect(settled[0]?.data).toMatchObject({ outcome: "completed", messageID: admitted.id })
    }),
  )

  it.effect("does not consult the policy when the drain is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = textResponse("policy-interrupt", "Interrupted")
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt" }), resume: false })
      const fiber = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* (yield* SessionExecution.Service).interrupt(sessionID)
      yield* Fiber.interrupt(fiber)

      expect(settleCalls).toHaveLength(0)
      const settled = yield* settledRows
      expect(settled).toHaveLength(1)
      expect(settled[0]?.data).toMatchObject({ outcome: "interrupted" })
    }),
  )
})
