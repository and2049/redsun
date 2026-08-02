export * as GoalV2 from "./goal-v2"

import { LLM, LLMClient, SystemPart } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionContinuationPolicy } from "@opencode-ai/core/session/continuation-policy"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Event } from "@opencode-ai/schema/event"
import { RedsunGoalEvent } from "@opencode-ai/schema/redsun-goal-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { continuationText, JUDGE_SYSTEM, judgeQuestion, parseVerdict, REACT_CAP, type Verdict } from "./goal-shared"

/**
 * Goal mode for v2 sessions. Durable goal state lives in the Redsun-owned
 * `redsun.session.goal.*` event family on the session aggregate; `GoalContinuationPolicy`
 * implements the runner's continuation-policy seam and mirrors the V1 judge semantics:
 * judge only at a genuine stop, judge errors permit stopping without clearing the goal,
 * satisfied/impossible/capped verdicts clear and stop, and unsatisfied verdicts admit a
 * durable steering continuation. Every state change also publishes the live V1
 * `session.goal` event so the TUI renders v2 goals through the existing bridge.
 */

type Db = Database.Interface["db"]

export type GoalState = {
  readonly condition: string
  readonly budget?: RedsunGoalEvent.Budget
  readonly setSeq: number
  readonly setTimestamp: DateTime.Utc
  readonly attempts: number
  readonly lastVerdict?: {
    readonly ok: boolean
    readonly impossible?: boolean
    readonly reason: string
    readonly attempt: number
    readonly judgedMessageID?: string
    readonly error?: boolean
  }
}

const PAGE = 500

export const get = Effect.fn("GoalV2.get")(function* (db: Db, sessionID: SessionSchema.ID) {
  let state: GoalState | undefined
  let after = -1
  while (true) {
    const page = yield* EventV2.readAggregate(db, {
      aggregateID: sessionID,
      after,
      limit: PAGE,
      manifest: RedsunGoalEvent.Manifest,
    })
    for (const event of page.events) {
      after = event.durable?.seq ?? after
      switch (event.type) {
        case "redsun.session.goal.set":
          state = {
            condition: event.data.condition,
            ...(event.data.budget === undefined ? {} : { budget: event.data.budget }),
            setSeq: event.durable?.seq ?? -1,
            setTimestamp: event.data.timestamp,
            attempts: 0,
          }
          break
        case "redsun.session.goal.cleared":
          state = undefined
          break
        case "redsun.session.goal.verdict":
          if (!state) break
          state = {
            ...state,
            attempts: Math.max(state.attempts, event.data.attempt),
            lastVerdict: {
              ok: event.data.ok,
              ...(event.data.impossible === undefined ? {} : { impossible: event.data.impossible }),
              reason: event.data.reason,
              attempt: event.data.attempt,
              ...(event.data.judgedMessageID === undefined ? {} : { judgedMessageID: event.data.judgedMessageID }),
              ...(event.data.judgeError === undefined ? {} : { error: event.data.judgeError }),
            },
          }
          break
      }
    }
    if (!page.hasMore) break
  }
  return state
})

const StepEndedManifest = {
  definitions: Event.durable([SessionEvent.Step.Ended]),
  schema: Schema.Union([SessionEvent.Step.Ended], { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type")),
} as const

/** Input + output + reasoning tokens spent since the goal was set; cache tokens excluded. */
export const spentTokens = Effect.fn("GoalV2.spentTokens")(function* (
  db: Db,
  sessionID: SessionSchema.ID,
  afterSeq: number,
) {
  let spent = 0
  let after = afterSeq
  while (true) {
    const page = yield* EventV2.readAggregate(db, {
      aggregateID: sessionID,
      after,
      limit: PAGE,
      manifest: StepEndedManifest,
    })
    for (const event of page.events) {
      after = event.durable?.seq ?? after
      spent += event.data.tokens.input + event.data.tokens.output + event.data.tokens.reasoning
    }
    if (!page.hasMore) break
  }
  return spent
})

const budgetExhausted = Effect.fn("GoalV2.budgetExhausted")(function* (
  db: Db,
  sessionID: SessionSchema.ID,
  state: GoalState,
) {
  const budget = state.budget
  if (!budget) return undefined
  if (budget.wallClockMs !== undefined) {
    const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(state.setTimestamp)
    if (elapsed >= budget.wallClockMs) return `wall-clock budget exhausted (${elapsed}ms of ${budget.wallClockMs}ms)`
  }
  if (budget.tokens !== undefined) {
    const spent = yield* spentTokens(db, sessionID, state.setSeq)
    if (spent >= budget.tokens) return `token budget exhausted (${spent} of ${budget.tokens} tokens)`
  }
  return undefined
})

const mirror = (
  events: EventV2.Interface,
  input: {
    sessionID: SessionSchema.ID
    goal?: { condition: string }
    lastVerdict?: NonNullable<GoalState["lastVerdict"]> & { messageID?: string }
  },
) =>
  events.publish(SessionV1.Event.GoalUpdated, {
    sessionID: input.sessionID,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.lastVerdict === undefined
      ? {}
      : {
          lastVerdict: {
            ok: input.lastVerdict.ok,
            ...(input.lastVerdict.impossible === undefined ? {} : { impossible: input.lastVerdict.impossible }),
            reason: input.lastVerdict.reason,
            attempt: input.lastVerdict.attempt,
            ...(input.lastVerdict.judgedMessageID === undefined
              ? {}
              : { messageID: input.lastVerdict.judgedMessageID }),
            ...(input.lastVerdict.error === undefined ? {} : { error: input.lastVerdict.error }),
          },
        }),
  })

export const set = Effect.fn("GoalV2.set")(function* (
  events: EventV2.Interface,
  input: { sessionID: SessionSchema.ID; condition: string; budget?: RedsunGoalEvent.Budget },
) {
  yield* events.publish(RedsunGoalEvent.Set, {
    timestamp: yield* DateTime.now,
    sessionID: input.sessionID,
    condition: input.condition,
    ...(input.budget === undefined ? {} : { budget: input.budget }),
  })
  yield* mirror(events, { sessionID: input.sessionID, goal: { condition: input.condition } })
})

export const clear = Effect.fn("GoalV2.clear")(function* (
  events: EventV2.Interface,
  input: { sessionID: SessionSchema.ID; reason: RedsunGoalEvent.ClearReason },
) {
  yield* events.publish(RedsunGoalEvent.Cleared, {
    timestamp: yield* DateTime.now,
    sessionID: input.sessionID,
    reason: input.reason,
  })
  yield* mirror(events, { sessionID: input.sessionID })
})

export const recordVerdict = Effect.fn("GoalV2.recordVerdict")(function* (
  events: EventV2.Interface,
  input: {
    sessionID: SessionSchema.ID
    condition: string
    verdict: Verdict
    attempt: number
    judgedMessageID?: SessionMessage.ID
    judgeError?: boolean
    /** Include the active goal in the live mirror when the goal continues past this verdict. */
    goal?: { condition: string }
  },
) {
  yield* events.publish(RedsunGoalEvent.Verdict, {
    timestamp: yield* DateTime.now,
    sessionID: input.sessionID,
    condition: input.condition,
    ok: input.verdict.ok,
    ...(input.verdict.impossible === undefined ? {} : { impossible: input.verdict.impossible }),
    reason: input.verdict.reason,
    attempt: input.attempt,
    ...(input.judgedMessageID === undefined ? {} : { judgedMessageID: input.judgedMessageID }),
    ...(input.judgeError === undefined ? {} : { judgeError: input.judgeError }),
  })
  yield* mirror(events, {
    sessionID: input.sessionID,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    lastVerdict: {
      ok: input.verdict.ok,
      ...(input.verdict.impossible === undefined ? {} : { impossible: input.verdict.impossible }),
      reason: input.verdict.reason,
      attempt: input.attempt,
      ...(input.judgedMessageID === undefined ? {} : { judgedMessageID: input.judgedMessageID }),
      ...(input.judgeError === undefined ? {} : { error: input.judgeError }),
    },
  })
})

const policyLayer = Layer.effect(
  SessionContinuationPolicy.Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const store = yield* SessionStore.Service
    const models = yield* SessionRunnerModel.Service

    const judge = Effect.fn("GoalV2.judge")(function* (input: {
      session: SessionSchema.Info
      condition: string
      context: SessionMessage.Message[]
    }) {
      const model = yield* models.resolve(input.session)
      const request = LLM.request({
        model,
        system: [SystemPart.make(JUDGE_SYSTEM)],
        messages: toLLMMessages(input.context, model),
        prompt: judgeQuestion(input.condition),
        tools: [],
        toolChoice: "none",
        generation: { temperature: 0 },
      })
      const response = yield* llm.generate(request)
      return yield* Effect.try({ try: () => parseVerdict(response.text), catch: (error) => error })
    })

    const onSettle: SessionContinuationPolicy.Interface["onSettle"] = ({ sessionID }) =>
      Effect.gen(function* () {
        const state = yield* get(db, sessionID)
        if (!state) return
        const exhausted = yield* budgetExhausted(db, sessionID, state)
        if (exhausted !== undefined) {
          // Budget exhaustion stops without spending a judge call.
          yield* recordVerdict(events, {
            sessionID,
            condition: state.condition,
            verdict: { ok: false, reason: `Goal ${exhausted}` },
            attempt: state.attempts,
          })
          yield* clear(events, { sessionID, reason: "capped" })
          return
        }
        const session = yield* store.get(sessionID)
        if (!session) return
        const context = yield* store.context(sessionID)
        const judgedMessageID = context.findLast((message) => message.type === "assistant")?.id
        const outcome = yield* judge({ session, condition: state.condition, context }).pipe(Effect.exit)

        if (Exit.isFailure(outcome)) {
          // V1 parity: a failed judge permits stopping but keeps the goal for the next turn.
          const reason = String(Cause.squash(outcome.cause))
          yield* Effect.logWarning("goal judge failed; allowing stop", { error: reason })
          yield* recordVerdict(events, {
            sessionID,
            condition: state.condition,
            goal: { condition: state.condition },
            verdict: { ok: false, reason },
            attempt: state.attempts,
            judgeError: true,
          })
          return
        }

        const verdict = outcome.value
        if (verdict.ok || verdict.impossible) {
          yield* recordVerdict(events, {
            sessionID,
            condition: state.condition,
            verdict,
            attempt: state.attempts,
            ...(judgedMessageID === undefined ? {} : { judgedMessageID }),
          })
          yield* clear(events, { sessionID, reason: verdict.ok ? "satisfied" : "impossible" })
          return
        }

        const attempt = state.attempts + 1
        if (attempt > REACT_CAP) {
          yield* recordVerdict(events, {
            sessionID,
            condition: state.condition,
            verdict,
            attempt,
            ...(judgedMessageID === undefined ? {} : { judgedMessageID }),
          })
          yield* clear(events, { sessionID, reason: "capped" })
          return
        }

        yield* recordVerdict(events, {
          sessionID,
          condition: state.condition,
          goal: { condition: state.condition },
          verdict,
          attempt,
          ...(judgedMessageID === undefined ? {} : { judgedMessageID }),
        })
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID,
          prompt: Prompt.make({ text: continuationText(state.condition, verdict.reason) }),
          delivery: "steer",
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("goal continuation policy failed", { error: String(Cause.squash(cause)) }),
        ),
      )

    return SessionContinuationPolicy.Service.of({ onSettle })
  }),
)

export const policyNode = makeLocationNode({
  service: SessionContinuationPolicy.Service,
  layer: policyLayer,
  deps: [Database.node, EventV2.node, SessionStore.node, SessionRunnerModel.node, llmClient],
})
