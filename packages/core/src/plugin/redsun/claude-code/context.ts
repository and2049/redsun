export * as ClaudeCodeContext from "./context.js"

import { createHash } from "node:crypto"
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeTurnBrief } from "./turn-brief.js"
import type { DelegatedCodeMode } from "@opencode/plugin/effect/delegate"

export interface File {
  readonly path: string
  readonly content: string
}

export interface SkillSummary {
  readonly id: string
  readonly name: string
  readonly description: string
}

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

type Snapshot = {
  agent: string
  files: ReadonlyMap<string, string>
  skills?: string
  /** The last delivered Code Mode summary (opaque, JSON-comparable). */
  codeMode?: unknown
}

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** The CLI already loads CLAUDE.md through settingSources; avoid a second delivery. */
const inherited = (file: File) => /(?:^|\/)CLAUDE\.md$/i.test(file.path)

export class Tracker {
  private delivered = new Map<string, Snapshot>()

  prepare(sessionID: string, input: Input): { text?: string; delivered: () => void } {
    if (input.freshProcess) this.clear(sessionID)
    const previous = input.freshProcess ? undefined : this.delivered.get(sessionID)
    const agent = fingerprint([input.agent, input.isWorker])
    const files = new Map(
      (input.files ?? []).filter((file) => !inherited(file)).map((file) => [file.path, file.content]),
    )
    const parts: string[] = []
    if (agent !== previous?.agent) {
      const brief = ClaudeCodeTurnBrief.make({ agent: input.agent, isWorker: input.isWorker, agentChanged: true })
      if (brief) parts.push(`[redsun agent instructions: ${input.agent.id}]\n${brief}`)
    }
    if (input.files !== undefined) {
      for (const [path, content] of files) {
        if (previous?.files.get(path) === content) continue
        parts.push(`Instructions from: ${path}\n${content}`)
      }
      for (const path of previous?.files.keys() ?? []) {
        if (!files.has(path)) parts.push(`The instructions from ${path} no longer apply.`)
      }
    }
    const skills = input.skills?.toSorted((a, b) => a.id.localeCompare(b.id))
    const skillRevision = skills === undefined ? previous?.skills : fingerprint(skills)
    if (skills !== undefined && skillRevision !== previous?.skills) {
      parts.push(
        skills.length
          ? [
              "Available redsun skills (load an applicable ID with mcp__redsun__skill; this catalog supersedes earlier redsun skill lists):",
              ...skills.map((skill) => `- ${JSON.stringify(skill)}`),
            ].join("\n")
          : "No redsun skills are currently available through the host skill loader; previous redsun skill lists no longer apply.",
      )
    }
    const codeMode = input.codeMode === undefined ? previous?.codeMode : input.codeMode?.summary
    if (input.codeMode !== undefined && JSON.stringify(codeMode) !== JSON.stringify(previous?.codeMode)) {
      parts.push(
        !input.codeMode
          ? "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools."
          : previous?.codeMode === undefined
            ? input.codeMode.render()
            : input.codeMode.update(previous.codeMode),
      )
    }
    const next = {
      agent,
      files: input.files === undefined ? (previous?.files ?? new Map()) : files,
      skills: skillRevision,
      codeMode,
    }
    return {
      ...(parts.length ? { text: parts.join("\n\n") } : {}),
      delivered: () => this.delivered.set(sessionID, next),
    }
  }

  clear(sessionID: string) {
    this.delivered.delete(sessionID)
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
