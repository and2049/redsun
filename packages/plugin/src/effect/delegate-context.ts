export * as DelegateContext from "./delegate-context.js"

import type { DelegatedCodeMode, DelegatedInstructionFile, DelegatedSkillSummary } from "./delegate.js"

// REDSUN: the host context a delegated runtime sends its agent, and what the agent already has.
// Every runtime needs the same "send once, resend what changed" bookkeeping; how the text reaches
// the agent (a submission hook, or text ahead of the prompt) is the runtime's own business.

export interface Agent {
  readonly id: string
  readonly mode?: string
  readonly system?: string
}

export interface Input {
  readonly agent: Agent
  readonly isWorker: boolean
  /** Omitted when instructions were not inspected this turn. */
  readonly files?: readonly DelegatedInstructionFile[]
  /** Omitted when the host skill loader is unavailable in this turn. */
  readonly skills?: readonly DelegatedSkillSummary[]
  /** null means Code Mode was removed; omitted means this source was not inspected. */
  readonly codeMode?: DelegatedCodeMode | null
  /** The agent holds none of the earlier context (a new agent session, or after compaction). */
  readonly fresh: boolean
}

export interface Options {
  /** Instruction files the agent loads itself, so the host never sends them. */
  readonly inherited?: (file: DelegatedInstructionFile) => boolean
  /** The skill tool's name as the agent sees it. */
  readonly skillTool: string
  /** Standing instructions for the agent that claims the session, sent when it changes. */
  readonly brief?: (input: { readonly agent: Agent; readonly isWorker: boolean }) => string | undefined
}

/** A prepared delivery: `text` to send, and `delivered` to call once the agent has it. */
export interface Delivery {
  readonly text?: string
  readonly delivered: () => void
}

interface Snapshot {
  readonly agent: string
  readonly files: ReadonlyMap<string, string>
  readonly skills?: string
  /** The last delivered Code Mode summary (opaque, JSON-comparable). */
  readonly codeMode?: unknown
}

export class Tracker {
  private readonly delivered = new Map<string, Snapshot>()

  constructor(private readonly options: Options) {}

  prepare(sessionID: string, input: Input): Delivery {
    if (input.fresh) this.clear(sessionID)
    const previous = input.fresh ? undefined : this.delivered.get(sessionID)
    const agent = JSON.stringify([input.agent, input.isWorker])
    const inherited = this.options.inherited ?? (() => false)
    const files = new Map(
      (input.files ?? []).filter((file) => !inherited(file)).map((file) => [file.path, file.content]),
    )
    const parts: string[] = []
    if (agent !== previous?.agent) {
      const brief = this.options.brief?.({ agent: input.agent, isWorker: input.isWorker })
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
    const skillRevision = skills === undefined ? previous?.skills : JSON.stringify(skills)
    if (skills !== undefined && skillRevision !== previous?.skills) {
      parts.push(
        skills.length
          ? [
              `Available redsun skills (load an applicable ID with ${this.options.skillTool}; this catalog supersedes earlier redsun skill lists):`,
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
    const next: Snapshot = {
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
