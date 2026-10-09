import { Schema } from "effect"
import { optional } from "./schema.js"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { ephemeral } from "./event.js"

export const Version = 1
export const LeaseSeconds = 30

export const Preference = Schema.Struct({ enabled: Schema.Boolean }).annotate({
  identifier: "RemoteControl.Preference",
})
export interface Preference extends Schema.Schema.Type<typeof Preference> {}

export const Status = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  state: Schema.Literals(["disabled", "unavailable", "ready", "connected"]),
  enrolled: Schema.Boolean,
  backendID: optional(Schema.String),
  processID: Schema.String,
  version: Schema.Literal(Version),
  leaseSeconds: Schema.Literal(LeaseSeconds),
}).annotate({ identifier: "RemoteControl.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Changed = ephemeral({ type: "remote.status", schema: Status.fields })
export const Sync = ephemeral({ type: "remote.sync", schema: {} })
export const AgentChoice = Schema.Struct({ id: Agent.ID, name: Agent.Name, mode: Agent.Info.fields.mode }).annotate({
  identifier: "RemoteControl.AgentChoice",
})
export interface AgentChoice extends Schema.Schema.Type<typeof AgentChoice> {}
export const ModelChoice = Schema.Struct({
  id: Model.ID,
  providerID: Model.Ref.fields.providerID,
  name: Schema.String,
  variants: Schema.Array(Schema.Struct({ id: Model.VariantID })),
}).annotate({ identifier: "RemoteControl.ModelChoice" })
export interface ModelChoice extends Schema.Schema.Type<typeof ModelChoice> {}

const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/))
const Actions = Schema.Struct({ primary: Color, secondary: Color, destructive: Color })
const Feedback = Schema.Struct({ error: Color, warning: Color, success: Color, info: Color })

export const Theme = Schema.Struct({
  name: Schema.String,
  mode: Schema.Literals(["light", "dark"]),
  colors: Schema.Struct({
    text: Schema.Struct({
      default: Color,
      subdued: Color,
      action: Actions,
      status: Schema.Struct({ running: Color, question: Color, permission: Color, unread: Color }),
      feedback: Feedback,
    }),
    background: Schema.Struct({ default: Color, offset: Color, overlay: Color, action: Actions, feedback: Feedback }),
    border: Schema.Struct({ default: Color }),
    diff: Schema.Struct({ added: Color, removed: Color }),
    markdown: Schema.Struct({
      text: Color,
      heading: Color,
      link: Color,
      linkText: Color,
      code: Color,
      blockQuote: Color,
      emphasis: Color,
      strong: Color,
      horizontalRule: Color,
      listItem: Color,
      listEnumeration: Color,
      image: Color,
      imageText: Color,
      codeBlock: Color,
    }),
  }),
}).annotate({ identifier: "RemoteControl.Theme" })
export interface Theme extends Schema.Schema.Type<typeof Theme> {}

export const PolicyResult = Schema.Struct({
  status: Status,
  persisted: Schema.Boolean,
}).annotate({ identifier: "RemoteControl.PolicyResult" })
export interface PolicyResult extends Schema.Schema.Type<typeof PolicyResult> {}

export const Heartbeat = Schema.Struct({ connected: Schema.Boolean }).annotate({
  identifier: "RemoteControl.Heartbeat",
})
export interface Heartbeat extends Schema.Schema.Type<typeof Heartbeat> {}
export const Enrollment = Schema.Struct({
  backendID: Schema.String,
  credentialID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: "RemoteControl.Enrollment" })
export interface Enrollment extends Schema.Schema.Type<typeof Enrollment> {}

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))
export const Approval = Schema.Struct({ requestID: Schema.String, fingerprint: Schema.String }).annotate({
  identifier: "RemoteControl.Approval",
})
export interface Approval extends Schema.Schema.Type<typeof Approval> {}
export const Companion = Schema.Struct({
  running: Schema.Boolean,
  error: optional(Schema.String),
  origin: optional(Schema.String),
  port: Port,
  pending: Schema.Array(Approval),
}).annotate({ identifier: "RemoteControl.Companion" })
export interface Companion extends Schema.Schema.Type<typeof Companion> {}
export const CompanionConfig = Schema.Struct({ origin: Schema.String, port: optional(Port) }).annotate({
  identifier: "RemoteControl.CompanionConfig",
})
export interface CompanionConfig extends Schema.Schema.Type<typeof CompanionConfig> {}
/** Phone access through the device's OpenTunnel tunnel: the companion is served on its own route. */
export const Tunnel = Schema.Struct({
  enabled: Schema.Boolean,
  origin: optional(Schema.String),
  state: Schema.Literals(["off", "issuing", "waiting", "attaching", "ready", "failed"]),
  error: optional(Schema.String),
}).annotate({ identifier: "RemoteControl.Tunnel" })
export interface Tunnel extends Schema.Schema.Type<typeof Tunnel> {}
export const TunnelConfig = Schema.Struct({ enabled: Schema.Boolean, rotate: optional(Schema.Boolean) }).annotate({
  identifier: "RemoteControl.TunnelConfig",
})
export interface TunnelConfig extends Schema.Schema.Type<typeof TunnelConfig> {}
/** Computer access: the backend itself on its own route of the device tunnel, for a redsun TUI on another computer. */
export const Computers = Schema.Struct(Tunnel.fields).annotate({ identifier: "RemoteControl.Computers" })
export interface Computers extends Schema.Schema.Type<typeof Computers> {}
export const ComputersConfig = Schema.Struct(TunnelConfig.fields).annotate({
  identifier: "RemoteControl.ComputersConfig",
})
export interface ComputersConfig extends Schema.Schema.Type<typeof ComputersConfig> {}
/** A one-time link another computer redeems for a session token with `redsun attach <link>`. */
export const Pairing = Schema.Struct({ link: Schema.String, code: Schema.String, expires_in: Schema.Int }).annotate({
  identifier: "RemoteControl.Pairing",
})
export interface Pairing extends Schema.Schema.Type<typeof Pairing> {}
/** Everything phone access needs, after the one call that turns it on. */
export const Access = Schema.Struct({ status: Status, tunnel: Tunnel, companion: Companion }).annotate({
  identifier: "RemoteControl.Access",
})
export interface Access extends Schema.Schema.Type<typeof Access> {}

export const Settings = Schema.Struct({
  enabled: optional(Schema.Boolean),
  origin: optional(Schema.String),
  port: optional(Port),
  backendID: optional(Schema.String),
  credentials: optional(Schema.Array(Enrollment).check(Schema.isMaxLength(8))),
  // The route outlives disabling: passkeys are bound to the origin it forms.
  tunnel: optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      // One DNS label, as OpenTunnel requires of a route.
      route: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
    }),
  ),
  // The backend's own route; kept across disabling so attached computers keep their address.
  computers: optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      route: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
      origin: optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "RemoteControl.Settings" })
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const Handoff = Schema.Struct({
  version: Schema.Literal(Version),
  backendID: Schema.String,
  registration: Schema.String,
  credentialID: Enrollment.fields.credentialID,
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
}).annotate({ identifier: "RemoteControl.Handoff" })
export interface Handoff extends Schema.Schema.Type<typeof Handoff> {}

export const Registration = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  url: Schema.String,
  pid: Schema.Int,
}).annotate({ identifier: "RemoteControl.Registration" })
export interface Registration extends Schema.Schema.Type<typeof Registration> {}

export * as RemoteControl from "./remote-control.js"
