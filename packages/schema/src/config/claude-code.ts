// REDSUN: configuration for the delegated Claude Code provider.
export * as ConfigClaudeCode from "./claude-code.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("ConfigClaudeCode.Info")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description: "Enable the Claude Code provider when the claude CLI is present. Defaults to true.",
  }),
  binary_path: Schema.String.pipe(optional).annotate({
    description: "Path to the claude executable. Defaults to resolving `claude` on PATH.",
  }),
  config_dir: Schema.String.pipe(optional).annotate({
    description: "Value for CLAUDE_CONFIG_DIR when launching the CLI. Never overrides HOME.",
  }),
  permission_mode: Schema.String.pipe(optional).annotate({
    description: "Claude Code permission mode for primary sessions.",
  }),
  worker_permission_mode: Schema.String.pipe(optional).annotate({
    description: 'Permission mode for delegated worker sessions. Defaults to "inherit".',
  }),
  extra_args: Schema.Array(Schema.String).pipe(optional).annotate({
    description: "Additional arguments passed to the claude CLI.",
  }),
  env: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Extra environment variables for the claude CLI process.",
  }),
}) {}
