export * as ClaudeCodeTurnBrief from "./turn-brief.js"

import { ClaudeCodePermissions } from "./permissions.js"

export interface Input {
  readonly agent: { readonly id: string; readonly mode?: string; readonly system?: string }
  readonly isWorker: boolean
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

export const make = (input: Input): string | undefined => {
  const parts: string[] = []

  // Mode briefs are standing instructions, not per-turn state: re-sending them on
  // every delegated turn breaks the CLI's prompt-cache prefix and buys nothing. They
  // ride only when the agent claims the session or changes, like agent.system.
  if (input.agentChanged) {
    if (input.agent.id === "compose") parts.push(COMPOSE)
    else if (input.isWorker || input.agent.mode === "subagent") parts.push(WORKER)
    if (input.agent.system) parts.push(input.agent.system)
  }

  if (!parts.length) return undefined
  return parts.join("\n\n")
}

export const prepend = (brief: string | undefined, text: string) =>
  brief === undefined ? text : text ? `${brief}\n\n${text}` : brief
