// REDSUN: the guarded Claude Agent SDK entry point.
export * as ClaudeCodeQuery from "./query.js"

import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeCodeSessions } from "./sessions.js"

/**
 * Production query factory.
 *
 * Redsun's compliance posture rests on driving the user's *installed* Claude
 * Code CLI. Without `pathToClaudeCodeExecutable` the SDK silently spawns its own
 * bundled cli.js, which must never happen — so this refuses instead of falling
 * back. Covered by a test; do not relax it.
 */
export const defaultCreateQuery: ClaudeCodeSessions.CreateQuery = (input) => {
  if (!input.options.pathToClaudeCodeExecutable)
    throw new Error("Claude Code query is missing pathToClaudeCodeExecutable; refusing to spawn the SDK's bundled CLI")
  return query(input) as ClaudeCodeSessions.QueryLike
}
