export * as RedsunAdvisor from "./advisor.js"

import path from "node:path"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Document, type Entry } from "@opencode-ai/schema/config"
import { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import { Effect, Exit, Queue, Schema, Stream } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Config } from "../../config.js"
import { SessionStore } from "../../session/store.js"
import { ClaudeCodeModels } from "./claude-code/models.js"

/**
 * Watchdog advisor (oh-my-pi inspired, ported from v1). A second model reviews each
 * completed drain with its own system prompt and no tools, then either stays silent,
 * records an aside the agent sees on its next turn (a synthetic that does not wake the
 * session), or interrupts with a steering prompt. Disabled unless `advisor.enabled` is
 * set. Reviews are best-effort: failures are logged and never affect the session.
 */

export const ADVISOR_INSTRUCTIONS = `You are a watchdog advisor reviewing another agent's coding session after a completed turn. Judge only from the transcript.

Return JSON: {"severity":"none"} when no intervention is warranted (the default), {"severity":"aside","note":"..."} for guidance the agent should see before its next turn, or {"severity":"interrupt","note":"..."} only for serious problems that must be corrected before work continues (destructive or unsafe actions, a clearly wrong direction, violating explicit user instructions). Notes must be terse and specific. Prefer "none" - do not nitpick style or restate what the agent already knows.`

/** Advisor instructions ride in the user turn so the request reuses the session's cached prefix. */
export const reviewQuestion = (guidance: string | undefined) =>
  [
    ADVISOR_INSTRUCTIONS,
    ...(guidance ? [`<guidance>\n${guidance}\n</guidance>`] : []),
    "Review the transcript above. Does the last completed turn warrant an advisory?",
  ].join("\n\n")

/** Message-metadata key stamped on advisor asides; the TUI colors these notices. */
export const METADATA_KEY = "redsun.advisor"

const EXECUTION_SUCCEEDED = "session.execution.succeeded"
const QUEUE_CAPACITY = 16
const MAX_TRACKED_PROMPTS = 256

export const Advisory = Schema.Struct({
  severity: Schema.Literals(["none", "aside", "interrupt"]),
  note: Schema.optional(Schema.String),
})
export type Advisory = typeof Advisory.Type

export type AdvisorConfig = NonNullable<Document["info"]["advisor"]>

/** Last document wins per field, matching v2 config precedence for scalar sections. */
export const advisorConfigFromEntries = (entries: readonly Entry[]): AdvisorConfig | undefined => {
  let merged: AdvisorConfig | undefined
  for (const entry of entries) {
    if (entry.type !== "document") continue
    const advisor = entry.info.advisor
    if (advisor !== undefined) merged = { ...merged, ...advisor }
  }
  return merged
}

export function parseAdvisory(input: string): Advisory {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  const value = fenced ?? (start >= 0 && end > start ? input.slice(start, end + 1) : input)
  return Schema.decodeUnknownSync(Advisory)(JSON.parse(value.trim()))
}

const GUIDANCE_FILES = ["WATCHDOG.md", "ADVISOR.md"]
const MAX_GUIDANCE_BYTES = 16_384
const MAX_GUIDANCE_WALK = 16

const parseModelRef = (route: string | undefined): Model.Ref | undefined => {
  if (!route) return undefined
  try {
    return Model.Ref.parse(route)
  } catch {
    return undefined
  }
}

export interface Services {
  readonly store: SessionStore.Interface
  readonly entries: () => Effect.Effect<readonly Entry[], unknown>
  readonly readFile: (filepath: string) => Effect.Effect<string | undefined, unknown>
}

export interface State {
  /** Steering prompts this advisor authored; their settlements must not re-trigger a review. */
  readonly advisorPrompts: Set<string>
  /** Sessions on cooldown: number of settlements to skip before advising again. */
  readonly cooldown: Map<string, number>
}

export const makeState = (): State => ({ advisorPrompts: new Set(), cooldown: new Map() })

/** The session domain surface a review needs; narrowed for tests. */
export interface SessionApi {
  readonly generate: (input: {
    sessionID: Session.ID
    prompt: string
    system?: string
    temperature?: number
    model?: Model.Ref
    tools?: boolean
  }) => Effect.Effect<{ text: string }, unknown>
  readonly prompt: (input: {
    sessionID: Session.ID
    text: string
    delivery?: "queue" | "steer"
  }) => Effect.Effect<{ id: string }, unknown>
  readonly synthetic: (input: {
    sessionID: Session.ID
    text: string
    description?: string
    metadata?: Record<string, unknown>
    resume?: boolean
  }) => Effect.Effect<unknown, unknown>
}

/**
 * Advisor-only guidance discovered by walking up from the session directory
 * (`WATCHDOG.md` beats `ADVISOR.md`, nearest directory wins). Never surfaces to the
 * session model — only the advisor reads it.
 */
export const loadGuidanceFile = Effect.fn("RedsunAdvisor.loadGuidanceFile")(function* (
  services: Services,
  directory: string,
) {
  let current = directory
  for (let depth = 0; depth < MAX_GUIDANCE_WALK; depth++) {
    for (const name of GUIDANCE_FILES) {
      const text = yield* services.readFile(path.join(current, name)).pipe(Effect.orElseSucceed(() => undefined))
      if (text !== undefined && text.trim().length > 0) return text.slice(0, MAX_GUIDANCE_BYTES)
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
})

/** Review one completed drain. Exposed for tests; the daemon serializes calls. */
export const review = Effect.fn("RedsunAdvisor.review")(function* (
  session: SessionApi,
  services: Services,
  state: State,
  sessionID: Session.ID,
) {
  const info = yield* services.store.get(sessionID)
  if (!info) return
  // Claude Code runs its own loop over a mirrored transcript; never advise on top of it.
  if (info.model && ClaudeCodeModels.isDelegated(info.model)) return

  // Self-trigger guard: a drain settled by this advisor's own steering prompt must not
  // spawn another review (and must not consume cooldown). The succeeded event carries no
  // message id, so key on the last user message in the delivered context — steer prompts
  // are delivered before their drain settles.
  const context = yield* services.store.context(sessionID).pipe(Effect.orElseSucceed(() => []))
  const lastUser = context.findLast((message) => message.type === "user")
  if (lastUser !== undefined && state.advisorPrompts.delete(lastUser.id as string)) return

  const cfg = advisorConfigFromEntries(yield* services.entries().pipe(Effect.orElseSucceed(() => [])))
  if (cfg?.enabled !== true) return
  const remaining = state.cooldown.get(sessionID) ?? 0
  if (remaining > 0) {
    state.cooldown.set(sessionID, remaining - 1)
    return
  }

  if (context.length === 0) return
  const judgedMessageID = context.findLast((message) => message.type === "assistant")?.id as string | undefined

  const guidance = cfg.guidance ?? (yield* loadGuidanceFile(services, info.location.directory))
  const advisory = yield* session
    .generate({
      sessionID,
      prompt: reviewQuestion(guidance),
      temperature: 0,
      tools: false,
      ...(parseModelRef(cfg.model) ? { model: parseModelRef(cfg.model) } : {}),
    })
    .pipe(
      Effect.flatMap((result) => Effect.try(() => parseAdvisory(result.text))),
      Effect.exit,
    )
  if (Exit.isFailure(advisory)) {
    yield* Effect.logWarning("advisor review failed to parse", { sessionID, cause: advisory.cause })
    return
  }
  if (advisory.value.severity === "none" || advisory.value.note === undefined || advisory.value.note.length === 0)
    return
  const severity =
    cfg.mode === "aside-only" && advisory.value.severity === "interrupt" ? "aside" : advisory.value.severity
  state.cooldown.set(sessionID, Math.max(0, cfg.cooldown_turns ?? 1))

  if (severity === "interrupt") {
    const admitted = yield* session.prompt({
      sessionID,
      text: `[advisor] ${advisory.value.note}`,
      delivery: "steer",
    })
    state.advisorPrompts.add(admitted.id)
    if (state.advisorPrompts.size > MAX_TRACKED_PROMPTS) {
      const oldest = state.advisorPrompts.values().next().value
      if (oldest !== undefined) state.advisorPrompts.delete(oldest)
    }
    return
  }
  // resume: false is what preserves "seen next turn, doesn't wake the session".
  yield* session.synthetic({
    sessionID,
    text: `[advisor] ${advisory.value.note}`,
    description: `[advisor] ${advisory.value.note}`,
    resume: false,
    metadata: {
      [METADATA_KEY]: { severity, ...(judgedMessageID ? { judgedMessageID } : {}) },
    },
  })
})

export const Plugin = define({
  id: "redsun.session.advisor",
  effect: Effect.fn(function* (ctx) {
    const store = yield* SessionStore.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const services: Services = {
      store,
      entries: () => config.entries(),
      readFile: (filepath) => fs.readFileStringSafe(filepath),
    }
    const state = makeState()

    // Dropping queue + single serialized consumer: bursts skip reviews instead of piling up.
    const queue = yield* Queue.dropping<Session.ID>(QUEUE_CAPACITY)
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === EXECUTION_SUCCEEDED),
      Stream.runForEach((event) => Queue.offer(queue, (event.data as { sessionID: Session.ID }).sessionID)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Queue.take(queue).pipe(
      Effect.flatMap((sessionID) =>
        review(ctx.session, services, state, sessionID).pipe(
          Effect.catchCause((cause) => Effect.logWarning("advisor review failed", { cause })),
        ),
      ),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
