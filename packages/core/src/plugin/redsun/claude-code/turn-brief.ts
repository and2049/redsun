// REDSUN: the per-turn brief prepended to a delegated prompt.
//
// A delegated turn sends no system prompt — `promptDelta` in language-model.ts
// carries the user text and nothing else, because Claude Code owns its own
// conversation. That means an agent's `system` never reaches the CLI, and the
// two agents that most need to say something are compose (delegate through
// redsun, not through your own Task tool) and worker (do not delegate at all).
//
// A prompt prefix rather than `systemPrompt.append` because the system prompt
// is fixed when the CLI process starts while the active agent can change on any
// turn of a live session.
//
// Plan and build get nothing: plan mode is covered end to end by the CLI's own
// reminder plus `planModeInstructions`, and build needs no guidance.
export * as ClaudeCodeTurnBrief from "./turn-brief.js"

import { ClaudeCodePermissions } from "./permissions.js"

export interface Input {
  readonly agent: { readonly id: string; readonly mode?: string; readonly system?: string }
  /** True when this session is a redsun subagent, i.e. it has a parent session. */
  readonly isWorker: boolean
  /** True on the first turn under this agent, so `system` is sent exactly once. */
  readonly agentChanged: boolean
}

const COMPOSE = [
  `[redsun compose mode] Delegate implementation and verification work with the`,
  `\`${ClaudeCodePermissions.ROUTED_SUBAGENT_TOOL}\` tool: use agent "worker" for scoped implementation and`,
  `"explore" for read-only discovery (the tool description lists every available type). Workers run on`,
  "whichever model redsun's worker routing assigns, which is often a different provider entirely — that",
  "routing is the point of compose mode. Pass a sessionID back to continue work on the same unit. Your",
  "built-in subagent tool is blocked in this session because it would run subagents inside Claude Code",
  "and bypass that routing.",
].join(" ")

const WORKER = [
  "[redsun worker] You are running as a redsun subagent. Do not delegate further —",
  "delegation is denied for this session.",
].join(" ")

/** Text to prepend to a turn's prompt, or undefined when nothing is needed. */
export const make = (input: Input): string | undefined => {
  const parts: string[] = []

  if (input.agent.id === "compose") parts.push(COMPOSE)
  else if (input.isWorker || input.agent.mode === "subagent") parts.push(WORKER)

  // Custom agents carry their own system prompt, which the delegated path
  // otherwise drops entirely. Send it once per agent switch — the CLI session
  // keeps it in conversation history from then on.
  if (input.agentChanged && input.agent.system) parts.push(input.agent.system)

  if (!parts.length) return undefined
  return parts.join("\n\n")
}

/** The brief joined onto a turn's text, or that text unchanged. */
export const prepend = (brief: string | undefined, text: string) =>
  brief === undefined ? text : text ? `${brief}\n\n${text}` : brief
