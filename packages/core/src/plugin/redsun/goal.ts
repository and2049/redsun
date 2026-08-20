export * as RedsunGoal from "./goal.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Session } from "@opencode-ai/schema/session"
import { Effect, Exit, Stream } from "effect"
import { KV } from "../../kv.js"
import { SessionStore } from "../../session/store.js"
import { ClaudeCodeModels } from "./claude-code/models.js"
import {
  GOAL_FEATURE_PROMPT,
  REACT_CAP,
  continuationText,
  judgeQuestion,
  JUDGE_SYSTEM,
  parseVerdict,
} from "./goal-shared.js"

export const key = (sessionID: string) => `redsun.goal/${sessionID}`

/** Prompt-metadata key the TUI writes: a condition string, or CLEAR to clear. */
export const METADATA_KEY = "redsun.goal"

export const CLEAR = "__clear__"

const EXECUTION_SUCCEEDED = "session.execution.succeeded"

export interface Services {
  readonly kv: KV.Interface
  readonly store: SessionStore.Interface
}

interface Stored {
  readonly condition: string
  readonly react: number
  readonly seen?: string
}

const readStored = (value: unknown): Stored | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { condition, react, seen } = value as Record<string, unknown>
  if (typeof condition !== "string" || condition.length === 0) return undefined
  const attempts = typeof react === "number" && Number.isFinite(react) ? Math.max(0, Math.floor(react)) : 0
  return { condition, react: attempts, ...(typeof seen === "string" ? { seen } : {}) }
}

const latestDirective = Effect.fn("RedsunGoal.latestDirective")(function* (services: Services, sessionID: Session.ID) {
  const messages = yield* services.store.context(sessionID).pipe(Effect.orElseSucceed(() => []))
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || (message.type !== "user" && message.type !== "synthetic")) continue
    const value = message.metadata?.[METADATA_KEY]
    if (typeof value !== "string" || value.length === 0) continue
    return { value, messageID: message.id as string }
  }
  return undefined
})

/**
 * The two writers — the TUI's prompt metadata and this plugin's own react bumps — are
 * ordered by stamping each stored value with the message id it came from, mirroring the
 * worker-model pattern.
 */
export const sync = Effect.fn("RedsunGoal.sync")(function* (services: Services, sessionID: Session.ID) {
  const stored = readStored(yield* services.kv.get(key(sessionID)))
  const directive = yield* latestDirective(services, sessionID)
  if (directive === undefined || directive.messageID === stored?.seen) return stored
  if (directive.value === CLEAR) {
    yield* services.kv.set(key(sessionID), { condition: "", react: 0, seen: directive.messageID })
    return undefined
  }
  const next = { condition: directive.value, react: 0, seen: directive.messageID }
  yield* services.kv.set(key(sessionID), next)
  return next
})

export const clear = (services: Services, sessionID: Session.ID) =>
  Effect.gen(function* () {
    const stored = readStored(yield* services.kv.get(key(sessionID)))
    yield* services.kv.set(key(sessionID), { condition: "", react: 0, ...(stored?.seen ? { seen: stored.seen } : {}) })
  })

const bumpReact = (services: Services, sessionID: Session.ID, stored: Stored) =>
  Effect.gen(function* () {
    const next = { ...stored, react: stored.react + 1 }
    yield* services.kv.set(key(sessionID), next)
    return next.react
  })

/** The session domain surface the review loop needs; narrowed for tests. */
export interface SessionApi {
  readonly generate: (input: { sessionID: Session.ID; prompt: string }) => Effect.Effect<{ text: string }, unknown>
  readonly prompt: (input: {
    sessionID: Session.ID
    text: string
    delivery?: "queue" | "steer"
  }) => Effect.Effect<unknown, unknown>
}

/**
 * Judge one settled drain. Ported v1 contract: a judge error permits stopping and keeps
 * the goal; ok/impossible clear and stop; the react cap clears and stops; otherwise the
 * react counter bumps and a steering continuation re-enters the session.
 */
export const review = Effect.fn("RedsunGoal.review")(function* (
  session: SessionApi,
  services: Services,
  sessionID: Session.ID,
) {
  const active = yield* sync(services, sessionID)
  if (active === undefined) return

  const info = yield* services.store.get(sessionID)
  if (info?.model && ClaudeCodeModels.isDelegated(info.model)) {
    // Claude Code runs its own /goal loop; never stack a second judge. Redsun only ever
    // held the condition for display, so drop it once the delegated drain settles.
    yield* clear(services, sessionID)
    return
  }

  // Queued-input preemption: a user message admitted after the judged drain means the
  // loop continues on real input — never judge over it. (v1's structural guard.)
  const messages = yield* services.store.context(sessionID).pipe(Effect.orElseSucceed(() => []))
  const lastUser = messages.findLastIndex((message) => message.type === "user")
  const lastAssistant = messages.findLastIndex(
    (message) => message.type === "assistant" || message.type === "compaction",
  )
  if (lastUser >= 0 && lastUser > lastAssistant) return

  const verdict = yield* session
    .generate({ sessionID, prompt: `${JUDGE_SYSTEM}\n\n${judgeQuestion(active.condition)}` })
    .pipe(
      Effect.flatMap((result) => Effect.try(() => parseVerdict(result.text))),
      Effect.exit,
    )

  if (Exit.isFailure(verdict)) {
    // Judge failure is a permissive outcome: allow the stop, keep the goal.
    yield* Effect.logWarning("goal judge failed", { sessionID, cause: verdict.cause })
    return
  }
  if (verdict.value.ok || verdict.value.impossible) {
    yield* clear(services, sessionID)
    return
  }
  const attempt = yield* bumpReact(services, sessionID, active)
  if (attempt > REACT_CAP) {
    yield* Effect.logWarning("goal react cap reached", { sessionID, attempt })
    yield* clear(services, sessionID)
    return
  }
  yield* session.prompt({
    sessionID,
    text: continuationText(active.condition, verdict.value.reason),
    delivery: "steer",
  })
})

export const Plugin = define({
  id: "redsun.session.goal",
  effect: Effect.fn(function* (ctx) {
    const kv = yield* KV.Service
    const store = yield* SessionStore.Service
    const services: Services = { kv, store }

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const active = yield* sync(services, event.sessionID)
        if (active !== undefined) event.system.push({ type: "text", text: GOAL_FEATURE_PROMPT })
      }),
    )

    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === EXECUTION_SUCCEEDED),
      Stream.runForEach((event) =>
        review(ctx.session, services, (event.data as { sessionID: Session.ID }).sessionID).pipe(
          Effect.catchCause((cause) => Effect.logWarning("goal review failed", { cause })),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
