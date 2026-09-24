export * as ConfigAcp from "./acp.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

// REDSUN: delegated agents spoken to over ACP (Agent Client Protocol). Kiro is built in when
// `kiro-cli` is on PATH; an entry here adjusts it or adds another agent.

const Strings = Schema.String.pipe(Schema.Array)

export class Agent extends Schema.Class<Agent>("ConfigAcp.Agent")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description: "Register this agent. Defaults to true.",
  }),
  preset: Schema.String.pipe(optional).annotate({
    description: 'Settings for a known agent ("kiro"); the entry\'s own keys override them.',
  }),
  name: Schema.String.pipe(optional).annotate({ description: "Provider display name." }),
  command: Schema.String.pipe(optional).annotate({ description: "The agent executable." }),
  args: Strings.pipe(optional).annotate({ description: "Arguments that start the agent's ACP server." }),
  env: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Extra environment variables for the agent process.",
  }),
  models: Schema.Union([Schema.String, Schema.Struct({ id: Schema.String, name: Schema.String.pipe(optional) })])
    .pipe(Schema.Array, optional)
    .annotate({ description: "Models to list instead of the ones the agent reports." }),
  host_tools: Schema.Literals(["extras", "all"]).pipe(optional).annotate({
    description: '"all" runs the agent on redsun\'s own tools; "extras" adds redsun\'s tools to the agent\'s.',
  }),
  inherited_instructions: Strings.pipe(optional).annotate({
    description: "Instruction files the agent loads itself, relative to the working directory.",
  }),
  native_approval_mode: Schema.String.pipe(optional).annotate({
    description: "The agent's own auto-approve session mode, offered as a third permission mode.",
  }),
  native_approval_args: Strings.pipe(optional).annotate({
    description: "Launch flags that make the agent auto-approve, offered as a third permission mode.",
  }),
  default_mode: Schema.String.pipe(optional).annotate({ description: "The session mode outside native approval." }),
  compact_command: Schema.String.pipe(optional).annotate({
    description: 'A prompt the agent treats as "compact your context".',
  }),
  home: Schema.Struct({
    env: Schema.String.pipe(optional),
    path: Schema.String.pipe(optional),
  })
    .pipe(optional)
    .annotate({ description: "Where the agent's managed home lives, and the variable that points it there." }),
}) {}

export class Info extends Schema.Class<Info>("ConfigAcp.Info")({
  agents: Schema.Record(Schema.String, Agent).pipe(optional).annotate({
    description: "ACP agents by provider id",
  }),
}) {}
