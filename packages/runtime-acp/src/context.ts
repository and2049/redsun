export * as AcpContext from "./context.js"

import path from "node:path"
import type { DelegatedInstructionFile, DelegatedSystemPrompt } from "@opencode/plugin/effect/delegate"
import type { DelegateContext } from "@opencode/plugin/effect/delegate-context"

// ACP has no channel for host context beside the user's prompt, so it rides at the start of the
// prompt in a labelled block; the delivery tracker sends it once and then only what changed.

const WORKER = [
  "[redsun worker] You are running as a redsun subagent. Do not delegate further —",
  "delegation is denied for this session.",
].join(" ")

/** Standing instructions for the agent that claims the session. */
export const brief = (input: { readonly agent: DelegateContext.Agent; readonly isWorker: boolean }) => {
  const parts: string[] = []
  if (input.isWorker || input.agent.mode === "subagent") parts.push(WORKER)
  if (input.agent.system) parts.push(input.agent.system)
  return parts.length ? parts.join("\n\n") : undefined
}

/** The same, when the base prompt is sent: it already carries the agent's own prompt. */
export const workerBrief = (input: { readonly agent: DelegateContext.Agent; readonly isWorker: boolean }) =>
  input.isWorker || input.agent.mode === "subagent" ? WORKER : undefined

export const BASE = "[redsun base instructions] The host's system prompt for this session; follow it as your own."

/** The host's base prompt, labelled as such; ahead of the rest of the host context. */
export const base = (system: DelegatedSystemPrompt) => {
  const parts = [...system.static, ...system.dynamic].filter((part) => part.trim())
  return parts.length ? [BASE, parts.join("\n\n")].join("\n") : undefined
}

/** Instruction files the agent loads itself (configured paths, relative to the working directory). */
export const inherited = (cwd: string, paths: readonly string[]) => {
  const own = new Set(paths.map((item) => path.resolve(cwd, item)))
  return (file: DelegatedInstructionFile) => own.has(path.resolve(cwd, file.path))
}

/** The skill tool as the agent sees it: served by the host MCP server named "redsun". */
export const SKILL_TOOL = 'the `skill` tool of the "redsun" MCP server'

export const OPEN = "<redsun-context>"
export const CLOSE = "</redsun-context>"

/** Corrections the user typed into declines during the last turn, ahead of the prompt. */
export const corrected = (corrections: readonly string[], prompt: string) =>
  corrections.length ? [...corrections.map((item) => `[redsun] ${item}`), "", prompt].join("\n") : prompt

/** Puts host context ahead of the prompt, marked as the host's and not the user's. */
export const wrap = (context: string | undefined, prompt: string) =>
  context
    ? [
        OPEN,
        "Context from redsun, the application hosting this session. It is not part of the user's message.",
        "",
        context,
        CLOSE,
        "",
        prompt,
      ].join("\n")
    : prompt
