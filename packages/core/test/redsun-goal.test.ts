import { expect, test } from "bun:test"
import { KV } from "@opencode-ai/core/kv"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Session } from "@opencode-ai/core/session"
import {
  RedsunGoal,
  CLEAR,
  METADATA_KEY,
  key,
  review,
  sync,
  type Services,
  type SessionApi,
} from "@opencode-ai/core/plugin/redsun/goal"
import { GOAL_FEATURE_PROMPT, REACT_CAP, continuationText } from "@opencode-ai/core/plugin/redsun/goal-shared"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const sessionID = Session.ID.make("ses_redsun_goal")

const message = (value: Record<string, unknown>) => decodeMessage({ time: { created: 0 }, ...value })

const user = (id: string, text: string, metadata?: Record<string, unknown>) =>
  message({ id, type: "user", text, ...(metadata ? { metadata } : {}) })

const assistant = (id: string) =>
  message({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test-provider" },
    content: [{ type: "text", text: "done" }],
    time: { created: 0 },
  })

type Setup = {
  readonly messages?: SessionMessage.Info[]
  readonly model?: { providerID: string; id: string }
  readonly generate?: string | Error
}

const setup = (input: Setup) => {
  const kvStore = new Map<string, unknown>()
  const kv: KV.Interface = {
    get: (k) => Effect.succeed(kvStore.get(k) as never),
    set: (k, value) => Effect.sync(() => void kvStore.set(k, value)),
    remove: (k) => Effect.sync(() => void kvStore.delete(k)),
  }
  const store = {
    get: () =>
      Effect.succeed({
        id: sessionID,
        model: input.model ?? { providerID: "test-provider", id: "test-model" },
      } as never),
    context: () => Effect.succeed(input.messages ?? []),
  } as unknown as SessionStore.Interface
  const prompts: { text: string; delivery?: string }[] = []
  let generateCalls = 0
  const session: SessionApi = {
    generate: () => {
      generateCalls++
      return input.generate instanceof Error
        ? Effect.fail(input.generate)
        : Effect.succeed({ text: input.generate ?? "" })
    },
    prompt: (value) => Effect.sync(() => void prompts.push({ text: value.text, delivery: value.delivery })),
  }
  const services: Services = { kv, store }
  return { kvStore, services, session, prompts, generateCalls: () => generateCalls }
}

const stored = (kvStore: Map<string, unknown>) => kvStore.get(key(sessionID)) as
  | { condition: string; react: number; seen?: string }
  | undefined

it.effect("sync arms the goal from prompt metadata and clears on the clear marker", () =>
  Effect.gen(function* () {
    const context = [user("msg_set", "ship it", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")]
    const { kvStore, services } = setup({ messages: context })
    const active = yield* sync(services, sessionID)
    expect(active).toMatchObject({ condition: "tests pass", react: 0, seen: "msg_set" })

    // A later react bump survives re-sync: the directive is stamped as seen.
    yield* services.kv.set(key(sessionID), { condition: "tests pass", react: 3, seen: "msg_set" })
    expect(yield* sync(services, sessionID)).toMatchObject({ react: 3 })

    context.push(message({ id: "msg_clear", type: "synthetic", text: "Goal cleared.", metadata: { [METADATA_KEY]: CLEAR } }))
    expect(yield* sync(services, sessionID)).toBeUndefined()
    expect(stored(kvStore)).toMatchObject({ condition: "", seen: "msg_clear" })
  }),
)

it.effect("an unsatisfied verdict bumps react and steers a continuation", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, prompts } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      generate: '{"ok":false,"reason":"tests still failing"}',
    })
    yield* review(session, services, sessionID)
    expect(prompts).toEqual([{ text: continuationText("tests pass", "tests still failing"), delivery: "steer" }])
    expect(stored(kvStore)).toMatchObject({ condition: "tests pass", react: 1 })
  }),
)

it.effect("satisfied and impossible verdicts clear the goal without a continuation", () =>
  Effect.gen(function* () {
    for (const verdict of ['{"ok":true,"reason":"done"}', '{"ok":false,"impossible":true,"reason":"cannot"}']) {
      const { kvStore, services, session, prompts } = setup({
        messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
        generate: verdict,
      })
      yield* review(session, services, sessionID)
      expect(prompts).toEqual([])
      expect(stored(kvStore)?.condition).toBe("")
    }
  }),
)

it.effect("a judge failure is permissive: stop allowed, goal kept", () =>
  Effect.gen(function* () {
    for (const generate of ["not json at all", new Error("model unavailable")] as const) {
      const { kvStore, services, session, prompts } = setup({
        messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
        generate,
      })
      yield* review(session, services, sessionID)
      expect(prompts).toEqual([])
      expect(stored(kvStore)).toMatchObject({ condition: "tests pass", react: 0 })
    }
  }),
)

it.effect("the react cap clears the goal instead of continuing forever", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, prompts } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      generate: '{"ok":false,"reason":"still going"}',
    })
    yield* services.kv.set(key(sessionID), { condition: "tests pass", react: REACT_CAP, seen: "msg_set" })
    yield* review(session, services, sessionID)
    expect(prompts).toEqual([])
    expect(stored(kvStore)?.condition).toBe("")
  }),
)

it.effect("delegated sessions are never judged and drop their stored goal", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, prompts, generateCalls } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      model: { providerID: "claude-code", id: "sonnet" },
      generate: '{"ok":false,"reason":"unused"}',
    })
    yield* review(session, services, sessionID)
    expect(generateCalls()).toBe(0)
    expect(prompts).toEqual([])
    expect(stored(kvStore)?.condition).toBe("")
  }),
)

it.effect("queued user input preempts judging", () =>
  Effect.gen(function* () {
    const { services, session, prompts, generateCalls } = setup({
      messages: [
        user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }),
        assistant("msg_a1"),
        user("msg_queued", "actually, do this instead"),
      ],
      generate: '{"ok":false,"reason":"unused"}',
    })
    yield* review(session, services, sessionID)
    expect(generateCalls()).toBe(0)
    expect(prompts).toEqual([])
  }),
)

it.effect("the plugin gates the feature prompt on an active goal and reviews on settlement", () =>
  Effect.gen(function* () {
    const messages = [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")]
    const { services, prompts } = setup({ messages })
    const kvLayer = Layer.mock(KV.Service)(services.kv)
    const storeLayer = Layer.mock(SessionStore.Service)(services.store)
    const hooks: Record<string, (event: never) => Effect.Effect<unknown, unknown, never>> = {}
    const settled = Stream.make({
      type: "session.execution.succeeded",
      data: { sessionID },
    })
    yield* RedsunGoal.Plugin.effect(
      host({
        event: { subscribe: () => settled as never },
        session: {
          hook: ((name: string, callback: (event: never) => Effect.Effect<unknown, unknown, never>) => {
            hooks[name] = callback
            return Effect.void
          }) as never,
          generate: (() => Effect.succeed({ text: '{"ok":false,"reason":"keep going"}' })) as never,
          prompt: ((input: { text: string; delivery?: string }) =>
            Effect.sync(() => void prompts.push({ text: input.text, delivery: input.delivery }))) as never,
        },
      }),
    ).pipe(Effect.provide(Layer.mergeAll(kvLayer, storeLayer)), Effect.scoped)

    expect(prompts).toEqual([{ text: continuationText("tests pass", "keep going"), delivery: "steer" }])

    const event = { sessionID, system: [] as { type: string; text: string }[], messages: [], tools: {} }
    yield* hooks["context"]!(event as never)
    expect(event.system.map((part) => part.text)).toContain(GOAL_FEATURE_PROMPT)

    // Cleared goal: no feature prompt.
    messages.push(message({ id: "msg_clear", type: "synthetic", text: "cleared", metadata: { [METADATA_KEY]: CLEAR } }))
    const after = { sessionID, system: [] as { type: string; text: string }[], messages: [], tools: {} }
    yield* hooks["context"]!(after as never)
    expect(after.system).toEqual([])
  }),
)
