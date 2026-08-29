export * as RedsunGoal from "./goal.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Session } from "@opencode-ai/schema/session"
import { DateTime, Effect, Exit, Stream } from "effect"
import { KV } from "../../kv.js"
import { SessionStore } from "../../session/store.js"
import { ClaudeCodeModels } from "./claude-code/models.js"
import { GOAL_FEATURE_PROMPT, REACT_CAP, continuationText, judgeQuestion, parseVerdict } from "./goal-shared.js"

export const key = (sessionID: string) => `redsun.goal/${sessionID}`

/** Prompt-metadata key the TUI writes: a condition string, or CLEAR to clear. */
export const METADATA_KEY = "redsun.goal"

/** Prompt-metadata key carrying the per-goal budget on the goal-set prompt. */
export const BUDGET_KEY = "redsun.goal.budget"

/** Message-metadata key carrying verdict payloads on plugin-authored messages. */
export const VERDICT_KEY = "redsun.goal.verdict"

export const CLEAR = "__clear__"

const EXECUTION_SUCCEEDED = "session.execution.succeeded"

export interface Services {
  readonly kv: KV.Interface
  readonly store: SessionStore.Interface
}

export interface Budget {
  readonly tokens?: number
  readonly wallClockMs?: number
}

export type ClearReason = "satisfied" | "impossible" | "capped" | "manual" | "judge-error" | "delegated"

export interface VerdictMeta {
  readonly ok: boolean
  readonly impossible?: boolean
  readonly reason: string
  readonly attempt: number
  readonly judgedMessageID?: string
  readonly error?: boolean
  readonly cleared?: ClearReason
}

interface Stored {
  readonly condition: string
  readonly react: number
  readonly seen?: string
  readonly budget?: Budget
  readonly setAt?: number
  readonly baseTokens?: number
}

const readBudget = (value: unknown): Budget | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { tokens, wallClockMs } = value as Record<string, unknown>
  const budget: { tokens?: number; wallClockMs?: number } = {}
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) budget.tokens = tokens
  if (typeof wallClockMs === "number" && Number.isFinite(wallClockMs) && wallClockMs >= 0)
    budget.wallClockMs = wallClockMs
  return budget.tokens !== undefined || budget.wallClockMs !== undefined ? budget : undefined
}

const readStored = (value: unknown): Stored | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { condition, react, seen, budget, setAt, baseTokens } = value as Record<string, unknown>
  if (typeof condition !== "string" || condition.length === 0) return undefined
  const attempts = typeof react === "number" && Number.isFinite(react) ? Math.max(0, Math.floor(react)) : 0
  const storedBudget = readBudget(budget)
  return {
    condition,
    react: attempts,
    ...(typeof seen === "string" ? { seen } : {}),
    ...(storedBudget ? { budget: storedBudget } : {}),
    ...(typeof setAt === "number" && Number.isFinite(setAt) ? { setAt } : {}),
    ...(typeof baseTokens === "number" && Number.isFinite(baseTokens) ? { baseTokens } : {}),
  }
}

const spentTokens = (info: Session.Info | undefined): number =>
  info?.tokens === undefined ? 0 : info.tokens.input + info.tokens.output + info.tokens.reasoning

const latestDirective = Effect.fn("RedsunGoal.latestDirective")(function* (services: Services, sessionID: Session.ID) {
  const messages = yield* services.store.context(sessionID).pipe(Effect.orElseSucceed(() => []))
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || (message.type !== "user" && message.type !== "synthetic")) continue
    const value = message.metadata?.[METADATA_KEY]
    if (typeof value !== "string" || value.length === 0) continue
    return {
      value,
      messageID: message.id as string,
      budget: readBudget(message.metadata?.[BUDGET_KEY]),
      createdAt: DateTime.toEpochMillis(message.time.created),
    }
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
  const info = directive.budget ? yield* services.store.get(sessionID) : undefined
  const next: Stored = {
    condition: directive.value,
    react: 0,
    seen: directive.messageID,
    ...(directive.budget
      ? { budget: directive.budget, setAt: directive.createdAt, baseTokens: spentTokens(info) }
      : {}),
  }
  yield* services.kv.set(key(sessionID), next as unknown as KV.Value)
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
    yield* services.kv.set(key(sessionID), next as unknown as KV.Value)
    return next.react
  })

/** The session domain surface the review loop needs; narrowed for tests. */
export interface SessionApi {
  readonly generate: (input: {
    sessionID: Session.ID
    prompt: string
    system?: string
    temperature?: number
    tools?: boolean
  }) => Effect.Effect<{ text: string }, unknown>
  readonly prompt: (input: {
    sessionID: Session.ID
    text: string
    delivery?: "queue" | "steer"
    metadata?: Record<string, unknown>
  }) => Effect.Effect<unknown, unknown>
  readonly synthetic: (input: {
    sessionID: Session.ID
    text: string
    description?: string
    metadata?: Record<string, unknown>
    resume?: boolean
  }) => Effect.Effect<unknown, unknown>
}

/**
 * Terminal clears go through the directive channel (a CLEAR synthetic with the verdict as
 * metadata) so messages stay the single source of truth for both this plugin's `sync` and
 * the TUI chip; the KV clear is belt-and-braces and reconciles idempotently.
 */
const clearWith = Effect.fn("RedsunGoal.clearWith")(function* (
  session: SessionApi,
  services: Services,
  sessionID: Session.ID,
  text: string,
  verdict: VerdictMeta,
) {
  yield* session.synthetic({
    sessionID,
    text,
    description: text,
    resume: false,
    metadata: { [METADATA_KEY]: CLEAR, [VERDICT_KEY]: verdict },
  })
  yield* clear(services, sessionID)
})

/**
 * Judge one settled drain. Ported v1 contract: budget exhaustion stops without spending a
 * judge call; a judge error permits stopping and keeps the goal; ok/impossible clear and
 * stop; the react cap clears and stops; otherwise the react counter bumps and a steering
 * continuation re-enters the session.
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
    yield* clearWith(session, services, sessionID, "Goal cleared: session is delegated to Claude Code.", {
      ok: false,
      reason: "session delegated to Claude Code",
      attempt: active.react,
      cleared: "delegated",
    })
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

  const judgedMessageID = messages.findLast((message) => message.type === "assistant")?.id as string | undefined

  // Budget exhaustion stops without spending a judge call. Wall clock first, then tokens
  // (input + output + reasoning since the goal was set; cache tokens excluded).
  if (active.budget) {
    let exhausted: string | undefined
    if (active.budget.wallClockMs !== undefined && active.setAt !== undefined) {
      const elapsed = Date.now() - active.setAt
      if (elapsed >= active.budget.wallClockMs)
        exhausted = `wall-clock budget exhausted (${elapsed}ms of ${active.budget.wallClockMs}ms)`
    }
    if (exhausted === undefined && active.budget.tokens !== undefined) {
      const spent = spentTokens(info) - (active.baseTokens ?? 0)
      if (spent >= active.budget.tokens)
        exhausted = `token budget exhausted (${spent} of ${active.budget.tokens} tokens)`
    }
    if (exhausted !== undefined) {
      yield* clearWith(session, services, sessionID, `Goal budget exhausted: ${exhausted}. Goal cleared.`, {
        ok: false,
        reason: `Goal ${exhausted}`,
        attempt: active.react,
        ...(judgedMessageID ? { judgedMessageID } : {}),
        cleared: "capped",
      })
      return
    }
  }

  const verdict = yield* session
    .generate({
      sessionID,
      prompt: judgeQuestion(active.condition),
      temperature: 0,
      tools: false,
    })
    .pipe(
      Effect.flatMap((result) => Effect.try(() => parseVerdict(result.text))),
      Effect.exit,
    )

  if (Exit.isFailure(verdict)) {
    // Judge failure is a permissive outcome: allow the stop, keep the goal.
    yield* Effect.logWarning("goal judge failed", { sessionID, cause: verdict.cause })
    yield* session.synthetic({
      sessionID,
      text: "Goal judge error (goal kept).",
      description: "Goal judge error (goal kept).",
      resume: false,
      metadata: {
        [VERDICT_KEY]: {
          ok: false,
          reason: String(verdict.cause),
          attempt: active.react,
          ...(judgedMessageID ? { judgedMessageID } : {}),
          error: true,
        } satisfies VerdictMeta,
      },
    })
    return
  }
  if (verdict.value.ok || verdict.value.impossible) {
    const cleared: ClearReason = verdict.value.ok ? "satisfied" : "impossible"
    yield* clearWith(session, services, sessionID, `Goal ${cleared}: ${verdict.value.reason}`, {
      ok: verdict.value.ok,
      ...(verdict.value.impossible ? { impossible: true } : {}),
      reason: verdict.value.reason,
      attempt: active.react,
      ...(judgedMessageID ? { judgedMessageID } : {}),
      cleared,
    })
    return
  }
  const attempt = yield* bumpReact(services, sessionID, active)
  if (attempt > REACT_CAP) {
    yield* Effect.logWarning("goal react cap reached", { sessionID, attempt })
    yield* clearWith(
      session,
      services,
      sessionID,
      `Goal continuation cap reached (${REACT_CAP}): goal cleared. Last verdict: ${verdict.value.reason}`,
      {
        ok: false,
        reason: verdict.value.reason,
        attempt,
        ...(judgedMessageID ? { judgedMessageID } : {}),
        cleared: "capped",
      },
    )
    return
  }
  yield* session.prompt({
    sessionID,
    text: continuationText(active.condition, verdict.value.reason),
    delivery: "steer",
    metadata: {
      [VERDICT_KEY]: {
        ok: false,
        reason: verdict.value.reason,
        attempt,
        ...(judgedMessageID ? { judgedMessageID } : {}),
      } satisfies VerdictMeta,
    },
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
