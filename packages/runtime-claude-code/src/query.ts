export * as ClaudeCodeQuery from "./query.js"

import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeCodeSessions } from "./sessions.js"

export const defaultCreateQuery: ClaudeCodeSessions.CreateQuery = (input) => {
  if (!input.options.pathToClaudeCodeExecutable)
    throw new Error("Claude Code query is missing pathToClaudeCodeExecutable; refusing to spawn the SDK's bundled CLI")
  return query(input) as ClaudeCodeSessions.QueryLike
}
