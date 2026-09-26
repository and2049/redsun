export * as ClaudeCodeContext from "./context.js"

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { AsyncLocalStorage } from "node:async_hooks"
import { DelegateContext } from "@opencode/plugin/effect/delegate-context"
import type {
  DelegatedCodeMode,
  DelegatedInstructionFile,
  DelegatedSkillSummary,
} from "@opencode/plugin/effect/delegate"
import type { ClaudeCodeProfiles } from "./profiles.js"
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
  readonly answers?: string
}

/** The CLI already loads CLAUDE.md through settingSources; avoid a second delivery. */
const inherited = (file: File) => /(?:^|\/)CLAUDE\.md$/i.test(file.path)

/** The shared delivery tracker with Claude Code's inherited files, skill tool and agent briefs. */
export class Tracker {
  private readonly shared: DelegateContext.Tracker

  constructor(profile?: ClaudeCodeProfiles.Name) {
    this.shared = new DelegateContext.Tracker({
      inherited,
      skillTool: "mcp__redsun__skill",
      brief: ({ agent, isWorker }) => ClaudeCodeTurnBrief.make({ agent, isWorker, agentChanged: true, profile }),
    })
  }

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

type Commit = (commit: () => void) => void
const immediate: Commit = (commit) => commit()

// CLI 2.1.283 persists each hook result above 10,000 characters, replacing it with a
// 2 KB preview. Register a bounded bank at process startup because context can grow on
// later turns and automatic compaction cannot reconfigure the process's hooks.
export const CHUNK_SIZE = 8_000
export const CHUNK_COUNT = 128
export const partition = (make: (commit: Commit) => HookCallback): HookCallback[] => {
  type Batch = {
    result: ReturnType<HookCallback>
    commits: Array<() => void>
    seen: Set<number>
    completed: Set<number>
    signals: AbortSignal[]
  }
  let active: Batch | undefined
  const collecting = new AsyncLocalStorage<Array<() => void>>()
  const callback = make((commit) => collecting.getStore()?.push(commit))
  return Array.from(
    { length: CHUNK_COUNT },
    (_, index): HookCallback =>
      async (event, toolUseID, options) => {
        // The CLI dispatches a hook bank in registration order (results may finish in any
        // order). A new leader supersedes an interrupted batch; never reuse partial output.
        if (index === 0) {
          const commits: Array<() => void> = []
          const batch: Batch = {
            commits,
            seen: new Set(),
            completed: new Set(),
            signals: [],
            result: Promise.resolve({}),
          }
          active = batch
          batch.result = collecting.run(commits, () => callback(event, toolUseID, options))
        }
        const batch = active
        const stop = () => ({
          continue: false,
          stopReason: "Redsun host context delivery was interrupted or exceeded its inline transport capacity.",
        })
        if (!batch || batch.seen.has(index)) return stop()
        batch.seen.add(index)
        batch.signals.push(options.signal)
        const result = await batch.result
        if (active !== batch || batch.signals.some((signal) => signal.aborted)) return {}
        if ("async" in result && result.async) return result
        const output = "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined
        const text = output && "additionalContext" in output ? output.additionalContext : undefined
        if (text && text.length > CHUNK_SIZE * CHUNK_COUNT) return stop()
        const start = index * CHUNK_SIZE
        // Include a split surrogate in the preceding chunk, without changing the text.
        const boundary = (n: number) =>
          text && /[\uD800-\uDBFF]/.test(text[n - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[n] ?? "") ? n + 1 : n
        const chunk = text?.slice(boundary(start), boundary(start + CHUNK_SIZE))
        batch.completed.add(index)
        if (batch.completed.size === CHUNK_COUNT) {
          for (const commit of batch.commits.splice(0)) commit()
        }
        if (!chunk || !output) return index === 0 ? result : {}
        return { ...result, hookSpecificOutput: { ...output, additionalContext: chunk } }
      },
  )
}

/** SDK hook context is separate from the user's prompt and native transcript text. */
export const submit = (
  current: () => ReturnType<Tracker["prepare"]> | undefined,
  commit: Commit = immediate,
): HookCallback => {
  const submitted = new WeakSet<ReturnType<Tracker["prepare"]>>()
  return async (event, _toolUseID, options) => {
    if (event.hook_event_name !== "UserPromptSubmit" || options.signal.aborted) return {}
    if (event.source && event.source !== "sdk" && event.source !== "user") return {}
    const delivery = current()
    if (!delivery || submitted.has(delivery)) return {}
    commit(() => {
      if (options.signal.aborted || current() !== delivery) return
      submitted.add(delivery)
      delivery.delivered()
    })
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
    commit: Commit = immediate,
  ): HookCallback =>
  async (event, _toolUseID, options) => {
    if (event.hook_event_name !== "SessionStart" || event.source !== "compact" || options.signal.aborted || !current())
      return {}
    const delivery = await prepare()
    if (options.signal.aborted || !current() || !delivery) return {}
    commit(() => {
      if (options.signal.aborted || !current()) return
      delivery.delivered()
      acknowledged()
    })
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
  commit: Commit = immediate,
): HookCallback => {
  let generation = 0
  return (event, toolUseID, options) => {
    if (event.hook_event_name !== "SessionStart" || event.source !== "compact") return Promise.resolve({})
    const binding = owner?.binding
    const token = ++generation
    const current = () =>
      !options.signal.aborted && !!binding && runtime() === owner && owner.binding === binding && generation === token
    return compact(() => prepare(current), acknowledged, current, commit)(event, toolUseID, options)
  }
}
