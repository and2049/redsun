export * as SessionMessagePin from "./session-message-pin.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"
import { Event } from "./event.js"
import { optional } from "./schema.js"

export const LabelLimit = 200
export const Label = Schema.String.check(Schema.isMaxLength(LabelLimit * 2))
export const Rename = Schema.Struct({ label: Schema.NullOr(Label) }).annotate({
  identifier: "SessionMessagePin.Rename",
})

export const Info = Schema.Struct({
  sessionID: SessionID,
  messageID: SessionMessage.ID,
  label: Schema.NullOr(Schema.String),
  preview: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  created: Schema.Finite,
  updated: Schema.Finite,
  messageCreated: Schema.Finite,
}).annotate({ identifier: "SessionMessagePin.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Page = Schema.Struct({
  data: Schema.Array(Info),
  next: optional(Schema.String),
}).annotate({ identifier: "SessionMessagePin.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

export const Updated = Event.ephemeral({ type: "session.pins.updated", schema: { sessionID: SessionID } })
