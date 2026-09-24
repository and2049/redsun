export * as ClaudeCodeContext from "./context.js"

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { DelegateContext } from "@opencode/plugin/effect/delegate-context"
import type {
  DelegatedCodeMode,
  DelegatedInstructionFile,
  DelegatedSkillSummary,
} from "@opencode/plugin/effect/delegate"
import { ClaudeCodeTurnBrief } from "./turn-brief.js"

export type File = DelegatedInstructionFile
export type SkillSummary = DelegatedSkillSummary

export interface Input {
  readonly agent: ClaudeCodeTurnBrief.Input["agent"]
  readonly isWorker: boolean
  readonly files?: readonly File[]
  /** Omitted when the host skill loader is unavailable in this turn. */
  readonly skills?: readonly SkillSummary[]
  /** null means execute was removed; omitted means this source was not inspected. */
  readonly codeMode?: DelegatedCodeMode | null
  readonly freshProcess: boolean
}

/** The CLI already loads CLAUDE.md through settingSources; avoid a second delivery. */
const inherited = (file: File) => /(?:^|\/)CLAUDE\.md$/i.test(file.path)

/** The shared delivery tracker with Claude Code's inherited files, skill tool and agent briefs. */
export class Tracker {
  private readonly shared = new DelegateContext.Tracker({
    inherited,
    skillTool: "mcp__redsun__skill",
    brief: ({ agent, isWorker }) => ClaudeCodeTurnBrief.make({ agent, isWorker, agentChanged: true }),
  })

  prepare(sessionID: string, input: Input): DelegateContext.Delivery {
    const { freshProcess, ...rest } = input
    return this.shared.prepare(sessionID, { ...rest, fresh: freshProcess })
  }

  clear(sessionID: string) {
    this.shared.clear(sessionID)
  }
}

/** Keep the epoch write and turn submission binding in one guarded synchronous step. */
export const commitIfCurrent = <T>(current: () => boolean, commit: () => T): T | undefined =>
  current() ? commit() : undefined

/** SDK hook context is separate from the user's prompt and native transcript text. */
export const submit = (current: () => ReturnType<Tracker["prepare"]> | undefined): HookCallback => {
  const submitted = new WeakSet<ReturnType<Tracker["prepare"]>>()
  return async (event, _toolUseID, options) => {
    if (event.hook_event_name !== "UserPromptSubmit" || options.signal.aborted) return {}
    if (event.source && event.source !== "sdk" && event.source !== "user") return {}
    const delivery = current()
    if (!delivery || submitted.has(delivery)) return {}
    submitted.add(delivery)
    delivery.delivered()
    return delivery.text
      ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delivery.text } }
      : {}
  }
}

/** Compaction starts a new native context epoch, including when it happens mid-turn. */
export const compact =
  (
    prepare: () => Promise<ReturnType<Tracker["prepare"]> | undefined>,
    acknowledged: () => void,
    current: () => boolean = () => true,
  ): HookCallback =>
  async (event, _toolUseID, options) => {
    if (event.hook_event_name !== "SessionStart" || event.source !== "compact" || options.signal.aborted || !current())
      return {}
    const delivery = await prepare()
    if (options.signal.aborted || !current() || !delivery) return {}
    delivery.delivered()
    acknowledged()
    return delivery.text
      ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: delivery.text } }
      : {}
  }

/** A process hook follows the live turn, but cannot write into a successor turn/process. */
export const compactForTurn = <T extends { binding?: unknown }>(
  owner: T | undefined,
  runtime: () => T | undefined,
  prepare: (current: () => boolean) => Promise<ReturnType<Tracker["prepare"]> | undefined>,
  acknowledged: () => void,
): HookCallback => {
  let generation = 0
  return (event, toolUseID, options) => {
    if (event.hook_event_name !== "SessionStart" || event.source !== "compact") return Promise.resolve({})
    const binding = owner?.binding
    const token = ++generation
    const current = () =>
      !options.signal.aborted && !!binding && runtime() === owner && owner.binding === binding && generation === token
    return compact(() => prepare(current), acknowledged, current)(event, toolUseID, options)
  }
}
