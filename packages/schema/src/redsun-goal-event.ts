export * as RedsunGoalEvent from "./redsun-goal-event"

import { Schema } from "effect"
import { Event } from "./event"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

/**
 * Redsun-owned durable goal events on the session aggregate. Deliberately kept out of
 * `SessionEvent.Durable` so the upstream session SSE/history unions stay untouched;
 * goal state is served by the Redsun API group and mirrored live for the TUI through
 * the V1 `session.goal` event.
 */

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

export const Budget = Schema.Struct({
  tokens: NonNegativeInt.pipe(optional),
  wallClockMs: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "redsun.session.goal.budget" })
export type Budget = typeof Budget.Type

export const Set = Event.define({
  type: "redsun.session.goal.set",
  ...options,
  schema: {
    ...Base,
    condition: Schema.String,
    budget: Budget.pipe(optional),
  },
})
export type Set = typeof Set.Type

export const ClearReason = Schema.Literals(["satisfied", "impossible", "capped", "manual", "judge-error"])
export type ClearReason = typeof ClearReason.Type

export const Cleared = Event.define({
  type: "redsun.session.goal.cleared",
  ...options,
  schema: {
    ...Base,
    reason: ClearReason,
  },
})
export type Cleared = typeof Cleared.Type

export const Verdict = Event.define({
  type: "redsun.session.goal.verdict",
  ...options,
  schema: {
    ...Base,
    condition: Schema.String,
    ok: Schema.Boolean,
    impossible: Schema.Boolean.pipe(optional),
    reason: Schema.String,
    attempt: NonNegativeInt,
    judgedMessageID: SessionMessage.ID.pipe(optional),
    judgeError: Schema.Boolean.pipe(optional),
  },
})
export type Verdict = typeof Verdict.Type

export const DurableDefinitions = Event.inventory(Set, Cleared, Verdict)
export const Definitions = DurableDefinitions

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "RedsunGoalDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const Manifest = {
  definitions: Event.durable(DurableDefinitions),
  schema: Durable,
} as const
