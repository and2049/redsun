import { expect } from "bun:test"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Session } from "@opencode-ai/core/session"
import {
  ADVISOR_SYSTEM,
  METADATA_KEY,
  advisorConfigFromEntries,
  makeState,
  parseAdvisory,
  review,
  type Services,
  type SessionApi,
  type State,
} from "@opencode-ai/core/plugin/redsun/advisor"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const sessionID = Session.ID.make("ses_redsun_advisor")

const message = (value: Record<string, unknown>) => decodeMessage({ time: { created: 0 }, ...value })

const user = (id: string, text: string) => message({ id, type: "user", text })

const assistant = (id: string) =>
  message({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test-provider" },
    content: [{ type: "text", text: "done" }],
    time: { created: 0 },
  })

type AdvisorConfigLike = {
  enabled?: boolean
  model?: string
  mode?: "auto" | "aside-only"
  cooldown_turns?: number
  guidance?: string
}

type Setup = {
  readonly messages?: SessionMessage.Info[]
  readonly model?: { providerID: string; id: string }
  readonly config?: AdvisorConfigLike
  readonly generate?: string | Error
  readonly files?: Record<string, string>
  readonly directory?: string
}

type GenerateInput = {
  prompt: string
  system?: string
  temperature?: number
  tools?: boolean
  model?: { providerID: string; id: string }
}

const setup = (input: Setup) => {
  const store = {
    get: () =>
      Effect.succeed({
        id: sessionID,
        model: input.model ?? { providerID: "test-provider", id: "test-model" },
        location: { directory: input.directory ?? "/project/nested", workspaceID: "ws" },
      } as never),
    context: () => Effect.succeed(input.messages ?? [user("msg_u1", "do it"), assistant("msg_a1")]),
  } as unknown as SessionStore.Interface
  const readFiles: string[] = []
  const services: Services = {
    store,
    entries: () =>
      Effect.succeed(
        input.config === undefined ? [] : ([{ type: "document", info: { advisor: input.config } }] as never),
      ),
    readFile: (filepath) =>
      Effect.sync(() => {
        readFiles.push(filepath)
        return input.files?.[filepath.replaceAll("\\", "/")]
      }),
  }
  const prompts: { text: string; delivery?: string }[] = []
  const synthetics: { text: string; description?: string; metadata?: Record<string, unknown>; resume?: boolean }[] = []
  const generateInputs: GenerateInput[] = []
  let promptCount = 0
  const session: SessionApi = {
    generate: (value) => {
      generateInputs.push({
        prompt: value.prompt,
        system: value.system,
        temperature: value.temperature,
        tools: value.tools,
        model: value.model,
      })
      return input.generate instanceof Error
        ? Effect.fail(input.generate)
        : Effect.succeed({ text: input.generate ?? '{"severity":"none"}' })
    },
    prompt: (value) => {
      prompts.push({ text: value.text, delivery: value.delivery })
      return Effect.succeed({ id: `msg_advisor_${++promptCount}` })
    },
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
  return { services, session, prompts, synthetics, generateInputs, readFiles, generateCalls: () => generateInputs.length }
}

it.effect("stays silent unless advisor.enabled is true", () =>
  Effect.gen(function* () {
    for (const config of [undefined, { enabled: false }] as const) {
      const { services, session, generateCalls } = setup({ config, generate: '{"severity":"aside","note":"n"}' })
      yield* review(session, services, makeState(), sessionID)
      expect(generateCalls()).toBe(0)
    }
  }),
)

it.effect("severity none and empty notes produce no output", () =>
  Effect.gen(function* () {
    for (const generate of ['{"severity":"none"}', '{"severity":"aside"}', '{"severity":"aside","note":""}']) {
      const { services, session, prompts, synthetics } = setup({ config: { enabled: true }, generate })
      yield* review(session, services, makeState(), sessionID)
      expect(prompts).toEqual([])
      expect(synthetics).toEqual([])
    }
  }),
)

it.effect("an aside lands as a non-waking synthetic with advisor metadata", () =>
  Effect.gen(function* () {
    const { services, session, prompts, synthetics, generateInputs } = setup({
      config: { enabled: true },
      generate: '{"severity":"aside","note":"tests were skipped"}',
    })
    yield* review(session, services, makeState(), sessionID)
    expect(prompts).toEqual([])
    expect(synthetics).toHaveLength(1)
    expect(synthetics[0]).toMatchObject({
      text: "[advisor] tests were skipped",
      description: "[advisor] tests were skipped",
      resume: false,
    })
    expect(synthetics[0]?.metadata?.[METADATA_KEY]).toMatchObject({ severity: "aside", judgedMessageID: "msg_a1" })
    // The review request runs with the advisor's own system prompt, no tools, temperature 0.
    expect(generateInputs[0]).toMatchObject({ system: ADVISOR_SYSTEM, temperature: 0, tools: false })
  }),
)

it.effect("an interrupt steers and its own settlement is not re-reviewed", () =>
  Effect.gen(function* () {
    const state = makeState()
    const first = setup({
      config: { enabled: true, cooldown_turns: 0 },
      generate: '{"severity":"interrupt","note":"stop deleting things"}',
    })
    yield* review(first.session, first.services, state, sessionID)
    expect(first.prompts).toEqual([{ text: "[advisor] stop deleting things", delivery: "steer" }])
    expect(state.advisorPrompts.has("msg_advisor_1")).toBe(true)

    // The advisor-authored prompt settles next: the guard skips before config or generate.
    const second = setup({
      config: { enabled: true, cooldown_turns: 0 },
      messages: [user("msg_u1", "do it"), assistant("msg_a1"), user("msg_advisor_1", "[advisor] ..."), assistant("msg_a2")],
      generate: '{"severity":"interrupt","note":"unused"}',
    })
    yield* review(second.session, second.services, state, sessionID)
    expect(second.generateCalls()).toBe(0)
    expect(state.advisorPrompts.size).toBe(0)
  }),
)

it.effect("aside-only mode downgrades interrupts to asides", () =>
  Effect.gen(function* () {
    const { services, session, prompts, synthetics } = setup({
      config: { enabled: true, mode: "aside-only" },
      generate: '{"severity":"interrupt","note":"serious problem"}',
    })
    yield* review(session, services, makeState(), sessionID)
    expect(prompts).toEqual([])
    expect(synthetics[0]?.metadata?.[METADATA_KEY]).toMatchObject({ severity: "aside" })
  }),
)

it.effect("an advisory arms the cooldown; quiet turns burn it down", () =>
  Effect.gen(function* () {
    const state = makeState()
    const make = () => setup({ config: { enabled: true }, generate: '{"severity":"aside","note":"note"}' })
    const first = make()
    yield* review(first.session, first.services, state, sessionID)
    expect(first.synthetics).toHaveLength(1)
    expect(state.cooldown.get(sessionID)).toBe(1)

    // Next settle is skipped (cooldown 1 -> 0) without calling the model.
    const second = make()
    yield* review(second.session, second.services, state, sessionID)
    expect(second.generateCalls()).toBe(0)

    // Cooldown spent: the advisor reviews again.
    const third = make()
    yield* review(third.session, third.services, state, sessionID)
    expect(third.synthetics).toHaveLength(1)
  }),
)

it.effect("delegated Claude Code sessions are never reviewed", () =>
  Effect.gen(function* () {
    const { services, session, generateCalls } = setup({
      config: { enabled: true },
      model: { providerID: "claude-code", id: "sonnet" },
      generate: '{"severity":"aside","note":"unused"}',
    })
    yield* review(session, services, makeState(), sessionID)
    expect(generateCalls()).toBe(0)
  }),
)

it.effect("a malformed advisory or model failure leaves the session untouched", () =>
  Effect.gen(function* () {
    for (const generate of ["not json", new Error("model unavailable")] as const) {
      const { services, session, prompts, synthetics } = setup({ config: { enabled: true }, generate })
      yield* review(session, services, makeState(), sessionID)
      expect(prompts).toEqual([])
      expect(synthetics).toEqual([])
    }
  }),
)

it.effect("inline guidance beats guidance files; the walk-up finds WATCHDOG.md", () =>
  Effect.gen(function* () {
    const inline = setup({
      config: { enabled: true, guidance: "never touch prod" },
      generate: '{"severity":"aside","note":"n"}',
    })
    yield* review(inline.session, inline.services, makeState(), sessionID)
    expect(inline.readFiles).toEqual([])
    expect(inline.generateInputs[0]?.system).toContain("<guidance>\nnever touch prod\n</guidance>")

    const walked = setup({
      config: { enabled: true },
      directory: "/project/nested",
      files: { "/project/WATCHDOG.md": "watch the tests" },
      generate: '{"severity":"aside","note":"n"}',
    })
    yield* review(walked.session, walked.services, makeState(), sessionID)
    expect(walked.generateInputs[0]?.system).toContain("<guidance>\nwatch the tests\n</guidance>")
  }),
)

it.effect("advisor.model overrides the review model as a parsed ref", () =>
  Effect.gen(function* () {
    const { services, session, generateInputs } = setup({
      config: { enabled: true, model: "anthropic/claude-haiku-4-5" },
      generate: '{"severity":"none"}',
    })
    yield* review(session, services, makeState(), sessionID)
    expect(generateInputs[0]?.model).toMatchObject({ providerID: "anthropic", id: "claude-haiku-4-5" })

    // An invalid route string falls back to the session model rather than failing.
    const invalid = setup({ config: { enabled: true, model: "no-slash" }, generate: '{"severity":"none"}' })
    yield* review(invalid.session, invalid.services, makeState(), sessionID)
    expect(invalid.generateInputs[0]?.model).toBeUndefined()
  }),
)

it.effect("config merge is last-document-wins per field", () =>
  Effect.gen(function* () {
    const merged = advisorConfigFromEntries([
      { type: "document", info: { advisor: { enabled: true, cooldown_turns: 3 } } },
      { type: "other", info: { advisor: { enabled: false } } },
      { type: "document", info: { advisor: { mode: "aside-only" } } },
    ] as never)
    expect(merged).toEqual({ enabled: true, cooldown_turns: 3, mode: "aside-only" })
  }),
)

it.effect("parseAdvisory handles fenced and prose-wrapped JSON", () =>
  Effect.gen(function* () {
    expect(parseAdvisory('```json\n{"severity":"aside","note":"n"}\n```')).toEqual({ severity: "aside", note: "n" })
    expect(parseAdvisory('Verdict: {"severity":"none"} as stated.')).toEqual({ severity: "none" })
    expect(() => parseAdvisory("no json here")).toThrow()
  }),
)
