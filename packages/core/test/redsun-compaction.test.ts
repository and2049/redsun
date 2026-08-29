import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, type LLMRequest } from "@opencode-ai/ai"
import { OpenAIChat } from "@opencode-ai/ai/protocols"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Bus } from "@opencode-ai/core/bus"
import { CompactionExtractor } from "@opencode-ai/core/session/compaction-extractor"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionModelRequest } from "@opencode-ai/core/session/model-request"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Session } from "@opencode-ai/core/session"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Document, Info as ConfigInfo } from "@opencode-ai/schema/config"
import { Money } from "@opencode-ai/schema/money"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const decodeConfig = Schema.decodeUnknownSync(ConfigInfo)

let requests: LLMRequest[] = []
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "llm summary" }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolvedModel = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost,
  limit: { context: 10_000, output: 1_000 },
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () => Effect.succeed(resolvedModel),
})

const harness = (compaction: Record<string, unknown>) => {
  const config = Layer.mock(Config.Service)({
    entries: () => Effect.succeed([new Document({ type: "document", info: decodeConfig({ compaction }) })]),
  })
  return testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        SessionStore.node,
        SessionCompaction.node,
        SessionModelRequest.node,
      ]),
      [
        [Bus.node, Bus.configured({ persist: true })],
        [llmClient, client],
        [Config.node, config],
        [SessionRunnerModel.node, models],
      ],
    ),
  )
}

// keep.tokens: 0 forces everything except the newest user turn into the head.
const hybrid = harness({ strategy: "hybrid", keep: { tokens: 0 }, keep_recent: 1 })
const algorithmic = harness({ strategy: "algorithmic", keep: { tokens: 0 } })

// Settings reach the service through ConfigCompactionPlugin's transform in production;
// these tests drive the same configure seam directly.
const configured = (settings: Partial<SessionCompaction.Settings>) =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    yield* compaction.transform((draft) => draft.configure(settings))
    return compaction
  })

const message = (value: Record<string, unknown>) => decodeMessage({ time: { created: 0 }, ...value })

const conversation = () => [
  message({
    id: "msg_user_one",
    type: "user",
    text: "Fix the login redirect bug in the auth flow.",
  }),
  message({
    id: "msg_assistant_one",
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test-provider" },
    content: [
      { type: "text", text: "The redirect drops the query string before validation." },
      {
        type: "tool",
        id: "call_read",
        name: "read",
        state: {
          status: "completed",
          input: { filePath: "src/auth/redirect.ts" },
          content: [{ type: "text", text: "export const redirect = () => target" }],
        },
        time: { created: 0 },
      },
      {
        type: "tool",
        id: "call_edit",
        name: "edit",
        state: {
          status: "error",
          input: { filePath: "src/auth/redirect.ts" },
          error: { type: "tool.execution", message: "oldString not found" },
        },
        time: { created: 0 },
      },
    ],
    time: { created: 0 },
  }),
  message({
    id: "msg_user_two",
    type: "user",
    text: "Also keep the fragment intact.",
  }),
]

const seedSession = (suffix: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make(`ses_redsun_compaction_${suffix}`)
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
        slug: `redsun-compaction-${suffix}`,
        directory: "/project",
        title: "Redsun compaction",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.die("session missing"))))
    return { session, store }
  })

test("extractor builds the bounded inventory from v2 messages", () => {
  const state = CompactionExtractor.extract(conversation())
  expect(state.task).toBe("Fix the login redirect bug in the auth flow.")
  expect(state.requirements).toEqual(["Also keep the fragment intact."])
  expect(state.files.get("src/auth/redirect.ts")).toEqual({ read: true, changed: true })
  expect(state.results).toEqual(["read: export const redirect = () => target"])
  expect(state.failures).toEqual(["edit: oldString not found"])
  expect(state.notes).toEqual(["The redirect drops the query string before validation."])

  const serialized = CompactionExtractor.serialize(state)
  expect(serialized.match(/^## .+$/gm)).toEqual([
    "## Task",
    "## User Requirements",
    "## Files Touched",
    "## Tool Results",
    "## Errors & Failures",
    "## Assistant Notes",
  ])
  expect(serialized).toContain("- `src/auth/redirect.ts`: changed; read")
})

test("extractor caps every category", () => {
  const long = "x".repeat(1_000)
  const messages = [
    message({ id: "msg_task", type: "user", text: long }),
    ...Array.from({ length: 30 }, (_, index) =>
      message({ id: `msg_req_${index}`, type: "user", text: `req ${index}` }),
    ),
    message({
      id: "msg_tools",
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      content: Array.from({ length: 40 }, (_, index) => ({
        type: "tool",
        id: `call_${index}`,
        name: "shell",
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: `output ${index}` }],
        },
        time: { created: 0 },
      })),
      time: { created: 0 },
    }),
  ]
  const state = CompactionExtractor.extract(messages, 5)
  expect(state.task).toHaveLength(500)
  expect(state.task.endsWith("...")).toBe(true)
  expect(state.requirements).toHaveLength(25)
  expect(state.requirements[0]).toBe("req 5")
  expect(state.results).toHaveLength(5)
  expect(state.results.at(-1)).toBe("shell: output 39")
})

test("buildPrompt folds the inventory in without repeating it downstream", () => {
  const prompt = SessionCompaction.buildPrompt({
    inventory: "## Task\n\nShip it",
    context: ["conversation"],
  })
  expect(prompt).toContain("## Structured Inventory")
  expect(prompt).toContain("Ship it")
  expect(prompt.indexOf("## Structured Inventory")).toBeLessThan(
    prompt.indexOf("The following is the conversation history:"),
  )
  expect(SessionCompaction.buildPrompt({ context: ["conversation"] })).not.toContain("## Structured Inventory")
})

hybrid.effect("hybrid compaction sends the inventory and only the recent head slice", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* configured({ strategy: "hybrid", tokens: 0, keepRecent: 1 })
    const { session } = yield* seedSession("hybrid")
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolvedModel),
        prepare: (yield* SessionModelRequest.Service).prepare,
        messages: conversation(),
        inputID: SessionMessage.ID.make("msg_compact_hybrid"),
      }),
    ).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    const prompt = JSON.stringify(requests[0]?.messages)
    expect(prompt).toContain("## Structured Inventory")
    expect(prompt).toContain("Fix the login redirect bug in the auth flow.")
    // keep_recent: 1 keeps only the assistant message in the serialized conversation.
    expect(prompt).not.toContain("[User]: Fix the login redirect bug in the auth flow.")
    expect(prompt).toContain("[Assistant]: The redirect drops the query string before validation.")
  }),
)

algorithmic.effect("algorithmic compaction completes without an LLM call", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* configured({ strategy: "algorithmic", tokens: 0 })
    const { session, store } = yield* seedSession("algorithmic")
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolvedModel),
        prepare: (yield* SessionModelRequest.Service).prepare,
        messages: conversation(),
        inputID: SessionMessage.ID.make("msg_compact_algorithmic"),
      }),
    ).toEqual({ status: "completed" })
    expect(requests).toHaveLength(0)
    const context = yield* store.context(session.id)
    expect(context).toMatchObject([{ type: "compaction", reason: "manual", status: "completed" }])
    const summary = context[0]?.type === "compaction" && context[0].status === "completed" ? context[0].summary : ""
    expect(summary).toContain("## Task")
    expect(summary).toContain("Fix the login redirect bug in the auth flow.")
    expect(summary).not.toContain("## Previous Summary")
  }),
)

algorithmic.effect("algorithmic compaction carries the previous summary forward", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* configured({ strategy: "algorithmic", tokens: 0 })
    const { session, store } = yield* seedSession("carry")
    const previous = message({
      id: "msg_previous_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "## Task\n\nEarlier anchored summary.",
      recent: "",
    })
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolvedModel),
        prepare: (yield* SessionModelRequest.Service).prepare,
        messages: [previous, ...conversation()],
        inputID: SessionMessage.ID.make("msg_compact_carry"),
      }),
    ).toEqual({ status: "completed" })
    expect(requests).toHaveLength(0)
    const context = yield* store.context(session.id)
    const summary = context[0]?.type === "compaction" && context[0].status === "completed" ? context[0].summary : ""
    expect(summary).toContain("## Previous Summary")
    expect(summary).toContain("Earlier anchored summary.")
    expect(summary).toContain("Fix the login redirect bug in the auth flow.")
  }),
)

hybrid.effect("compaction serializes only the latest read of a file", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* configured({ strategy: "hybrid", tokens: 0, keepRecent: 10 })
    const { session } = yield* seedSession("stale-read")
    const read = (id: string, text: string) => ({
      type: "tool",
      id,
      name: "read",
      state: { status: "completed", input: { path: "src/auth/redirect.ts" }, content: [{ type: "text", text }] },
      time: { created: 0 },
    })
    const messages = [
      message({ id: "msg_user_stale", type: "user", text: "Fix the login redirect bug in the auth flow." }),
      message({
        id: "msg_assistant_stale",
        type: "assistant",
        agent: "build",
        model: { id: "test-model", providerID: "test-provider" },
        content: [read("call_read_old", "OLD_READ_CONTENT"), read("call_read_new", "NEW_READ_CONTENT")],
        time: { created: 0 },
      }),
      message({ id: "msg_user_stale_two", type: "user", text: "Also keep the fragment intact." }),
    ]
    expect(
      yield* compaction.compactManual({
        session,
        resolveModel: () => Effect.succeed(resolvedModel),
        prepare: (yield* SessionModelRequest.Service).prepare,
        messages,
        inputID: SessionMessage.ID.make("msg_compact_stale"),
      }),
    ).toEqual({ status: "completed" })
    const prompt = JSON.stringify(requests[0]?.messages)
    expect(prompt).toContain("[Tool result]: [superseded by a later read of the same file]")
    expect(prompt).toContain("[Tool result]: NEW_READ_CONTENT")
    expect(prompt).not.toContain("[Tool result]: OLD_READ_CONTENT")
  }),
)
