import { expect, test } from "bun:test"
import { KV } from "@opencode-ai/core/kv"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Session } from "@opencode-ai/core/session"
import {
  RedsunGoal,
  BUDGET_KEY,
  CLEAR,
  METADATA_KEY,
  VERDICT_KEY,
  key,
  review,
  sync,
  type Services,
  type SessionApi,
} from "@opencode-ai/core/plugin/redsun/goal"
import { GOAL_FEATURE_PROMPT, JUDGE_SYSTEM, REACT_CAP, continuationText } from "@opencode-ai/core/plugin/redsun/goal-shared"
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
  readonly tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

type GenerateInput = { prompt: string; system?: string; temperature?: number; tools?: boolean }

type SyntheticCall = {
  text: string
  description?: string
  metadata?: Record<string, unknown>
  resume?: boolean
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
        ...(input.tokens ? { tokens: input.tokens } : {}),
      } as never),
    context: () => Effect.succeed(input.messages ?? []),
  } as unknown as SessionStore.Interface
  const prompts: { text: string; delivery?: string; metadata?: Record<string, unknown> }[] = []
  const synthetics: SyntheticCall[] = []
  const generateInputs: GenerateInput[] = []
  const session: SessionApi = {
    generate: (value) => {
      generateInputs.push({
        prompt: value.prompt,
        system: value.system,
        temperature: value.temperature,
        tools: value.tools,
      })
      return input.generate instanceof Error
        ? Effect.fail(input.generate)
        : Effect.succeed({ text: input.generate ?? "" })
    },
    prompt: (value) =>
      Effect.sync(() => void prompts.push({ text: value.text, delivery: value.delivery, metadata: value.metadata })),
    synthetic: (value) =>
      Effect.sync(
        () =>
          void synthetics.push({
            text: value.text,
            description: value.description,
            metadata: value.metadata,
            resume: value.resume,
          }),
      ),
  }
  const services: Services = { kv, store }
  return { kvStore, services, session, prompts, synthetics, generateInputs, generateCalls: () => generateInputs.length }
}

const stored = (kvStore: Map<string, unknown>) =>
  kvStore.get(key(sessionID)) as
    | {
        condition: string
        react: number
        seen?: string
        budget?: { tokens?: number; wallClockMs?: number }
        setAt?: number
        baseTokens?: number
      }
    | undefined

const verdictOf = (call: SyntheticCall | { metadata?: Record<string, unknown> } | undefined) =>
  call?.metadata?.[VERDICT_KEY] as
    | {
        ok: boolean
        impossible?: boolean
        reason: string
        attempt: number
        judgedMessageID?: string
        error?: boolean
        cleared?: string
      }
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

it.effect("sync arms budget, setAt, and baseTokens from the goal-set message", () =>
  Effect.gen(function* () {
    const context = [
      user("msg_set", "goal", {
        [METADATA_KEY]: "tests pass",
        [BUDGET_KEY]: { tokens: 5000, wallClockMs: 60_000 },
      }),
      assistant("msg_a1"),
    ]
    const { kvStore, services } = setup({
      messages: context,
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 999, write: 999 } },
    })
    const active = yield* sync(services, sessionID)
    expect(active).toMatchObject({
      condition: "tests pass",
      budget: { tokens: 5000, wallClockMs: 60_000 },
      setAt: 0,
      baseTokens: 150, // input + output + reasoning; cache excluded
    })

    // The budget survives a react bump.
    yield* services.kv.set(key(sessionID), { ...stored(kvStore), react: 2 } as never)
    expect(yield* sync(services, sessionID)).toMatchObject({ react: 2, budget: { tokens: 5000 }, baseTokens: 150 })
  }),
)

it.effect("an exhausted token budget clears without spending a judge call", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, synthetics, generateCalls } = setup({
      messages: [
        user("msg_set", "goal", { [METADATA_KEY]: "tests pass", [BUDGET_KEY]: { tokens: 100 } }),
        assistant("msg_a1"),
      ],
      // baseTokens arms at 150 on sync; by review time the same totals mean 0 spent, so
      // pre-seed KV with a lower base to simulate spend since arming.
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
      generate: '{"ok":false,"reason":"unused"}',
    })
    yield* services.kv.set(key(sessionID), {
      condition: "tests pass",
      react: 4,
      seen: "msg_set",
      budget: { tokens: 100 },
      setAt: 0,
      baseTokens: 10,
    })
    yield* review(session, services, sessionID)
    expect(generateCalls()).toBe(0)
    expect(stored(kvStore)?.condition).toBe("")
    const clearCall = synthetics[0]
    expect(clearCall?.metadata?.[METADATA_KEY]).toBe(CLEAR)
    expect(clearCall?.resume).toBe(false)
    expect(clearCall?.description).toBe(clearCall?.text)
    expect(verdictOf(clearCall)).toMatchObject({ ok: false, attempt: 4, cleared: "capped", judgedMessageID: "msg_a1" })
    expect(verdictOf(clearCall)?.reason).toContain("token budget exhausted (140 of 100 tokens)")
  }),
)

it.effect("a zero wall-clock budget is immediately exhausted", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, synthetics, generateCalls } = setup({
      messages: [
        user("msg_set", "goal", { [METADATA_KEY]: "tests pass", [BUDGET_KEY]: { wallClockMs: 0 } }),
        assistant("msg_a1"),
      ],
      generate: '{"ok":false,"reason":"unused"}',
    })
    yield* review(session, services, sessionID)
    expect(generateCalls()).toBe(0)
    expect(stored(kvStore)?.condition).toBe("")
    expect(verdictOf(synthetics[0])).toMatchObject({ cleared: "capped" })
    expect(verdictOf(synthetics[0])?.reason).toContain("wall-clock budget exhausted")
  }),
)

it.effect("an unexhausted budget still reaches the judge", () =>
  Effect.gen(function* () {
    const { services, session, prompts, generateCalls } = setup({
      messages: [
        user("msg_set", "goal", { [METADATA_KEY]: "tests pass", [BUDGET_KEY]: { tokens: 1_000_000 } }),
        assistant("msg_a1"),
      ],
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
      generate: '{"ok":false,"reason":"keep going"}',
    })
    yield* review(session, services, sessionID)
    expect(generateCalls()).toBe(1)
    expect(prompts).toHaveLength(1)
  }),
)

it.effect("the judge call carries its own system prompt, temperature 0, and no tools", () =>
  Effect.gen(function* () {
    const { services, session, generateInputs } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      generate: '{"ok":true,"reason":"done"}',
    })
    yield* review(session, services, sessionID)
    expect(generateInputs).toHaveLength(1)
    expect(generateInputs[0]).toMatchObject({ system: JUDGE_SYSTEM, temperature: 0, tools: false })
    expect(generateInputs[0]?.prompt).toContain("tests pass")
    expect(generateInputs[0]?.prompt).not.toContain(JUDGE_SYSTEM)
  }),
)

it.effect("an unsatisfied verdict bumps react and steers a continuation with verdict metadata", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, prompts } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      generate: '{"ok":false,"reason":"tests still failing"}',
    })
    yield* review(session, services, sessionID)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      text: continuationText("tests pass", "tests still failing"),
      delivery: "steer",
    })
    // The verdict rides as metadata but never the directive key, so sync ignores it.
    expect(prompts[0]?.metadata?.[METADATA_KEY]).toBeUndefined()
    expect(verdictOf(prompts[0])).toMatchObject({
      ok: false,
      reason: "tests still failing",
      attempt: 1,
      judgedMessageID: "msg_a1",
    })
    expect(stored(kvStore)).toMatchObject({ condition: "tests pass", react: 1 })
  }),
)

it.effect("satisfied and impossible verdicts clear through the directive channel", () =>
  Effect.gen(function* () {
    const cases = [
      { generate: '{"ok":true,"reason":"done"}', cleared: "satisfied", text: "Goal satisfied: done" },
      {
        generate: '{"ok":false,"impossible":true,"reason":"cannot"}',
        cleared: "impossible",
        text: "Goal impossible: cannot",
      },
    ] as const
    for (const item of cases) {
      const { kvStore, services, session, prompts, synthetics } = setup({
        messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
        generate: item.generate,
      })
      yield* review(session, services, sessionID)
      expect(prompts).toEqual([])
      expect(stored(kvStore)?.condition).toBe("")
      expect(synthetics).toHaveLength(1)
      expect(synthetics[0]).toMatchObject({ text: item.text, description: item.text, resume: false })
      expect(synthetics[0]?.metadata?.[METADATA_KEY]).toBe(CLEAR)
      expect(verdictOf(synthetics[0])).toMatchObject({ cleared: item.cleared, judgedMessageID: "msg_a1" })
    }
  }),
)

it.effect("a judge failure is permissive: stop allowed, goal kept, error verdict posted", () =>
  Effect.gen(function* () {
    for (const generate of ["not json at all", new Error("model unavailable")] as const) {
      const { kvStore, services, session, prompts, synthetics } = setup({
        messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
        generate,
      })
      yield* review(session, services, sessionID)
      expect(prompts).toEqual([])
      expect(stored(kvStore)).toMatchObject({ condition: "tests pass", react: 0 })
      // The error verdict never clears: no directive key, goal survives.
      expect(synthetics).toHaveLength(1)
      expect(synthetics[0]?.metadata?.[METADATA_KEY]).toBeUndefined()
      expect(synthetics[0]?.resume).toBe(false)
      expect(verdictOf(synthetics[0])).toMatchObject({ ok: false, error: true })
    }
  }),
)

it.effect("the react cap clears the goal instead of continuing forever", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, prompts, synthetics } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      generate: '{"ok":false,"reason":"still going"}',
    })
    yield* services.kv.set(key(sessionID), { condition: "tests pass", react: REACT_CAP, seen: "msg_set" })
    yield* review(session, services, sessionID)
    expect(prompts).toEqual([])
    expect(stored(kvStore)?.condition).toBe("")
    expect(synthetics[0]?.metadata?.[METADATA_KEY]).toBe(CLEAR)
    expect(verdictOf(synthetics[0])).toMatchObject({ cleared: "capped", attempt: REACT_CAP + 1 })
  }),
)

it.effect("delegated sessions are never judged and drop their stored goal visibly", () =>
  Effect.gen(function* () {
    const { kvStore, services, session, prompts, synthetics, generateCalls } = setup({
      messages: [user("msg_set", "goal", { [METADATA_KEY]: "tests pass" }), assistant("msg_a1")],
      model: { providerID: "claude-code", id: "sonnet" },
      generate: '{"ok":false,"reason":"unused"}',
    })
    yield* review(session, services, sessionID)
    expect(generateCalls()).toBe(0)
    expect(prompts).toEqual([])
    expect(stored(kvStore)?.condition).toBe("")
    // The clear goes through the directive channel so the TUI chip drops too.
    expect(synthetics[0]?.metadata?.[METADATA_KEY]).toBe(CLEAR)
    expect(verdictOf(synthetics[0])).toMatchObject({ cleared: "delegated" })
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
          synthetic: (() => Effect.void) as never,
        },
      }),
    ).pipe(Effect.provide(Layer.mergeAll(kvLayer, storeLayer)), Effect.scoped)

    expect(prompts).toMatchObject([{ text: continuationText("tests pass", "keep going"), delivery: "steer" }])

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
