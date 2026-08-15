/**
 * Per-turn mode brief for delegated Claude Code turns.
 *
 * Redsun's agent modes are enforced by permission rulesets and by the SDK
 * `permissionMode`, but a few of them also need Claude Code to be *told*
 * something it cannot infer — chiefly that compose must delegate through
 * redsun's routed `task` tool rather than Claude Code's built-in `Task`.
 *
 * This is delivered as a prompt prefix rather than `systemPrompt.append`
 * because the system prompt is fixed when the CLI process starts, while the
 * active agent can change on any turn of a live session.
 *
 * Plan and build get nothing: plan mode is covered end-to-end by the CLI's own
 * plan-mode reminder plus `planModeInstructions`, and build needs no guidance.
 */

export interface BriefInput {
  readonly agent: { name: string; mode: string; prompt?: string }
  /** True when this session is a redsun subagent (child of another session). */
  readonly isWorker: boolean
  /** True when redsun's routed `task` tool is available to this turn. */
  readonly hasRedsunTask: boolean
  /** True on the first turn under this agent, so `agent.prompt` is sent once. */
  readonly agentChanged: boolean
}

export const TASK_TOOL = "mcp__redsun__task"

const COMPOSE = [
  `[redsun compose mode] Delegate implementation and verification work with the \`${TASK_TOOL}\` tool:`,
  `use subagent_type "worker" for scoped implementation and "explore" for read-only discovery (the tool`,
  "description lists every available type). Workers run on whichever model redsun's worker routing assigns,",
  "which is often a different provider entirely — that routing is the point of compose mode. Reuse a",
  "task_id to continue work on the same unit. Your built-in Task tool is blocked in this session because",
  "it would run subagents inside Claude Code and bypass that routing.",
].join(" ")

const WORKER = [
  "[redsun worker] You are running as a redsun subagent. Do not delegate further —",
  "task delegation is denied for this session.",
].join(" ")

/** Text to prepend to a turn's prompt, or undefined when nothing is needed. */
export function brief(input: BriefInput): string | undefined {
  const parts: string[] = []

  if (input.agent.name === "compose" && input.hasRedsunTask) parts.push(COMPOSE)
  else if (input.isWorker || input.agent.mode === "subagent") parts.push(WORKER)

  // Custom agents carry their own system prompt, which the delegated path
  // otherwise drops entirely. Send it once per agent switch — the CLI session
  // keeps it in conversation history from then on.
  if (input.agentChanged && input.agent.prompt) parts.push(input.agent.prompt)

  if (!parts.length) return undefined
  return parts.join("\n\n")
}

export * as ClaudeCodeModes from "./modes"
