export * as RedsunAdvisorEvent from "./redsun-advisor-event"

import { Schema } from "effect"
import { Event } from "./event"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

/**
 * Redsun-owned durable advisor events on the session aggregate. Kept out of
 * `SessionEvent.Durable` so the upstream session SSE/history unions stay untouched.
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

export const Severity = Schema.Literals(["interrupt", "aside"])
export type Severity = typeof Severity.Type

export const Issued = Event.define({
  type: "redsun.session.advisory.issued",
  ...options,
  schema: {
    ...Base,
    severity: Severity,
    note: Schema.String,
    judgedMessageID: SessionMessage.ID.pipe(optional),
    model: Schema.String.pipe(optional),
  },
})
export type Issued = typeof Issued.Type

export const DurableDefinitions = Event.inventory(Issued)
export const Definitions = DurableDefinitions

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "RedsunAdvisorDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const Manifest = {
  definitions: Event.durable(DurableDefinitions),
  schema: Durable,
} as const
