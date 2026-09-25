export * as ClaudeCodeProfiles from "./profiles.js"

import { createHash } from "node:crypto"

/** `claude_code.behavior`: location configuration, fixed for the plugin's lifetime. */
export type Name = "redsun" | "extended" | "native"

export const DEFAULT: Name = "redsun"

export const HOST_PREFIX = "mcp__redsun__"

/**
 * Native tools a host tool already covers (native name → host tool id). `extended` removes them
 * from the CLI's context with `disallowedTools`; `redsun` has no built-ins at all. The CLI's
 * inventory changes per version: audit this table at each SDK refresh, beside the model pins.
 * Non-duplicates at 2.1.282 (kept in `extended`): ExitPlanMode, EnterPlanMode, Monitor,
 * SendMessage, ListAgents, ScheduleWakeup, Workflow, CronCreate/Delete/List, LSP,
 * EnterWorktree/ExitWorktree, RemoteTrigger, PushNotification, DesignSync, ReportFindings, REPL.
 */
export const DUPLICATES: Readonly<Record<string, string>> = {
  Bash: "shell",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Agent: "subagent",
  Task: "subagent",
  TaskStop: "subagent",
  Skill: "skill",
  AskUserQuestion: "question",
  TodoWrite: "todowrite",
  TaskCreate: "todowrite",
  TaskGet: "todowrite",
  TaskUpdate: "todowrite",
  TaskList: "todowrite",
  // redsun edits notebooks as files.
  NotebookEdit: "edit",
  // Code Mode is redsun's deferred-tool mechanism; ToolSearch would defer the host catalog.
  ToolSearch: "execute",
}

/**
 * SDK `toolAliases` (native name → `mcp__redsun__<id>`): a name-only redirect for model-emitted
 * native names. It does not translate arguments, so an entry belongs here only once the host
 * schema accepts the native payload as is (`test/redsun-claude-code-aliases.test.ts` proves each
 * entry). No entry qualifies yet; no argument adapters are written.
 */
export const ALIASES: Readonly<Record<string, string>> = {}

export interface Profile {
  readonly name: Name
  /** SDK `tools`; `[]` disables every built-in. Undefined keeps the preset set. */
  readonly tools?: readonly string[]
  readonly disallowedTools: readonly string[]
  readonly toolAliases: Readonly<Record<string, string>>
  /** `host`: redsun's base prompt (`ctx.delegate.context.system`); otherwise the preset. */
  readonly systemPrompt: "host" | "preset-behavior" | "preset"
  /** Whether the plan agent runs in SDK `plan` mode with the ExitPlanMode bridge. */
  readonly sdkPlanMode: boolean
  /** `all`: the whole host snapshot; `compose-subagent`: host `subagent` for compose only. */
  readonly hostTools: "all" | "compose-subagent"
  /** Whether native tools exist for the CLI's classifier to judge (`native_auto`). */
  readonly nativeApproval: boolean
}

export const PROFILES: Readonly<Record<Name, Profile>> = {
  redsun: {
    name: "redsun",
    tools: [],
    disallowedTools: [],
    toolAliases: ALIASES,
    systemPrompt: "host",
    sdkPlanMode: false,
    hostTools: "all",
    nativeApproval: false,
  },
  extended: {
    name: "extended",
    disallowedTools: Object.keys(DUPLICATES),
    toolAliases: ALIASES,
    systemPrompt: "preset-behavior",
    sdkPlanMode: true,
    hostTools: "all",
    nativeApproval: true,
  },
  native: {
    name: "native",
    disallowedTools: [],
    toolAliases: {},
    systemPrompt: "preset",
    sdkPlanMode: true,
    hostTools: "compose-subagent",
    nativeApproval: true,
  },
}

export const resolve = (behavior: string | undefined): Profile =>
  behavior === "extended" || behavior === "native" ? PROFILES[behavior] : PROFILES[DEFAULT]

/** A stable identity for the system prompt a fresh native session records. */
export const promptHash = (prompt: unknown) =>
  createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 16)

/**
 * The resume cursor stored per host session. The CLI records a session's system prompt on its
 * first request, so a cursor is resumed only under the profile that recorded it. A legacy plain
 * string predates profiles and has no known profile.
 */
export interface Cursor {
  readonly cursor: string
  readonly profile?: Name
  readonly promptHash?: string
}

export const parseCursor = (value: unknown): Cursor | undefined => {
  if (typeof value === "string") return value ? { cursor: value } : undefined
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.cursor !== "string" || !record.cursor) return undefined
  const profile =
    record.profile === "redsun" || record.profile === "extended" || record.profile === "native"
      ? record.profile
      : undefined
  return {
    cursor: record.cursor,
    ...(profile ? { profile } : {}),
    ...(typeof record.promptHash === "string" ? { promptHash: record.promptHash } : {}),
  }
}

/**
 * Whether a stored cursor may be resumed under `profile`. Only the profile decides: within one
 * profile the recorded prompt legitimately differs by agent (tool guidance follows the served
 * tools, and an agent switch re-binds the catalog), and the CLI keeps the recorded prompt until
 * compaction, which is the documented behaviour.
 */
export const resumable = (stored: Cursor, profile: Name) => stored.profile === profile

/** The identity stored with a new cursor: the profile it was recorded under and its prompt. */
export const record = (cursor: string, profile: Name, promptHash?: string): Cursor => ({
  cursor,
  profile,
  ...(promptHash ? { promptHash } : {}),
})

/** The notice row shown when stored native history is not resumed. */
export const staleNotice = (stored: Cursor, profile: Name) => ({
  text: `Claude Code's native history for this session was recorded under ${
    stored.profile ? `the "${stored.profile}" behavior profile` : "an earlier version of redsun"
  } and was not resumed; this turn starts a fresh Claude Code session under the "${profile}" profile. The redsun transcript is unchanged.`,
  description: "Claude Code native history not resumed",
})
