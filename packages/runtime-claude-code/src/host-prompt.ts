export * as ClaudeCodeHostPrompt from "./host-prompt.js"

import type { DelegateDomain } from "@opencode/plugin/effect/delegate"
import type { Effect } from "effect"
import HOST from "./prompt/host.txt" with { type: "text" }

export interface Context extends Effect.Success<ReturnType<DelegateDomain["context"]["environment"]>> {
  readonly sessionID: string
}

/** Add only host-specific policy/facts; the CLI supplies its own environment and date. */
export const make = (host?: Context) =>
  [
    HOST.trim(),
    ...(host
      ? [
          `Redsun host session ID: ${host.sessionID}. This is distinct from the native Claude Code session ID.`,
          `Prefer ${host.temporaryDirectory} for temporary files; it is pre-created and approved for external access.`,
          ...(host.workspaceRoot !== host.directory ? [`Redsun workspace root: ${host.workspaceRoot}.`] : []),
        ]
      : []),
  ].join("\n\n")
