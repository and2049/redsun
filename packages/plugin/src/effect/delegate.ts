import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Usage } from "@ai-sdk/provider"
import type { ToolDefinition } from "@opencode/ai"
import type { Permission } from "@opencode/schema/permission"
import type { Tool } from "@opencode/schema/tool"
import type { Effect, Schema, Scope } from "effect"
import type { Registration } from "./registration.js"
import type { SessionRequestKind } from "./session.js"

/**
 * REDSUN: one model request routed to a delegated runtime. Core supplies the identity that a
 * plain language model call cannot carry.
 */
export interface DelegatedTurn {
  readonly sessionID: string
  /** Set for child sessions (workers, subagents). */
  readonly parentID?: string
  readonly agent: string
  /** `primary` is an agent-loop turn; the other kinds are one-shot host requests. */
  readonly kind: SessionRequestKind
  /** The model id within the runtime's provider. */
  readonly modelID: string
  /** The host assistant message this turn streams into (primary turns only). */
  readonly assistantMessageID?: string
}

export type DelegatedStreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>

/**
 * REDSUN: an external coding agent that runs its own agent loop behind a provider (an ACP agent
 * such as Kiro). The runtime owns model calls, its native transcript, native tools and compaction;
 * the host keeps sessions, UI, agent selection and permission policy.
 *
 * The provider's models need an `aisdk:`-prefixed `package` so the resolver routes them through
 * the AI SDK path; core never loads that package for a registered runtime.
 */
export interface DelegatedRuntime {
  readonly id: string
  /** Every model of this provider is delegated to the runtime. */
  readonly providerID: string
  /**
   * Runs one request. `options` are the AI SDK call options core built for the request (prompt,
   * tools, tool choice, abort signal); the stream uses AI SDK V3 stream parts, with the runtime's
   * own tool calls marked `providerExecuted`.
   */
  readonly turn: (turn: DelegatedTurn, options: LanguageModelV3CallOptions) => PromiseLike<DelegatedStreamResult>
  /**
   * How a manual compaction request is handled. The runtime compacts its own context, so the host
   * never runs its compaction; `command` is admitted as a steering prompt the runtime understands
   * (e.g. `/compact`). Omitted, the request fails with `notice` or a generic message.
   */
  readonly compaction?: {
    readonly notice: string
    readonly command?: string
  }
}

export interface DelegatedPermissionCheck {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Record<string, unknown>
}

/** The host's answer to an interactive approval; a decline may carry the user's correction. */
export type DelegatedApproval = { readonly ok: true } | { readonly ok: false; readonly feedback?: string }

/** Key-value storage under the stable prefix `redsun.<runtime id>`; keys are appended verbatim. */
export interface DelegatedStorage {
  readonly get: (key: string) => Effect.Effect<Schema.Json | undefined>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

export interface DelegatedToolResult extends Tool.Result {
  readonly content: ReadonlyArray<Tool.Content>
}

/**
 * Code Mode's catalog as the host renders it. `summary` is opaque but JSON-comparable: keep the
 * last delivered one and pass it back to `update` for a differential notice.
 */
export interface DelegatedCodeMode {
  readonly summary: unknown
  readonly render: () => string
  readonly update: (previous: unknown) => string
}

/**
 * One turn's host tools: the snapshot the agent and session permissions allow, bound to the
 * turn's attribution. Execute through it only; results carry the metadata tool rows render.
 */
export interface DelegatedToolBinding {
  readonly definitions: ReadonlyArray<ToolDefinition>
  /** Connected MCP tools exposed directly rather than through Code Mode, by registered name. */
  readonly direct: ReadonlySet<string>
  /** Present when the snapshot carries Code Mode's catalog. */
  readonly codeMode?: DelegatedCodeMode
  readonly execute: (input: {
    readonly name: string
    readonly args: unknown
    /** A stable id for the call; prefer the runtime's native tool-use id. */
    readonly callID: string
    /** Restricts execution to these advertised names. */
    readonly allowed?: ReadonlySet<string>
    readonly signal: AbortSignal
  }) => Promise<DelegatedToolResult>
}

export interface DelegatedInstructionFile {
  readonly path: string
  readonly content: string
}

export interface DelegatedSkillSummary {
  readonly id: string
  readonly name: string
  readonly description: string
}

/**
 * The host's base prompt for a delegated session, split for a runtime that records its system
 * prompt once per native session. `static` is the same on every request of the session (the
 * agent's own prompt or the host's base prompt with guidance for the served tools); `dynamic`
 * changes between sessions (environment, date) and is the runtime's to place where it can
 * change. Instruction files, memory, skills and Code Mode are not here: `context.instructions`,
 * `context.skills` and `tools.bind().codeMode` deliver those, and their changes.
 */
export interface DelegatedSystemPrompt {
  readonly static: readonly string[]
  readonly dynamic: readonly string[]
}

export interface DelegateDomain {
  readonly register: (runtime: DelegatedRuntime) => Effect.Effect<Registration, never, Scope.Scope>
  /** Whether a registered runtime owns this model's agent loop. */
  readonly owns: (model: { readonly providerID: string }) => Effect.Effect<boolean>
  /**
   * Live read of a top-level config key, or of a nested field given as a path; the
   * highest-priority document that sets that exact key or field wins.
   */
  readonly config: (key: string | readonly string[]) => Effect.Effect<unknown>
  readonly storage: (runtimeID: string) => DelegatedStorage
  readonly permission: {
    /** Prompts when policy asks; `save` persists an "always" answer for these resources. */
    readonly assert: (
      input: DelegatedPermissionCheck & { readonly save?: readonly string[] },
    ) => Effect.Effect<DelegatedApproval>
    /** The session-wide approval mode the user selected. */
    readonly mode: () => Effect.Effect<Permission.Mode>
  }
  readonly tools: {
    /** Fails when the session or agent no longer exists. */
    readonly bind: (input: {
      readonly sessionID: string
      readonly agent: string
      readonly messageID: string
    }) => Effect.Effect<DelegatedToolBinding, Error>
  }
  readonly context: {
    /**
     * The location's discovered instruction files (AGENTS.md chain, project memory), each bounded
     * to `instruction_max_chars`; project memory carries its maintenance policy. Undefined while
     * discovery is unavailable, which is not a removal: keep what was last delivered.
     */
    readonly instructions: () => Effect.Effect<readonly DelegatedInstructionFile[] | undefined>
    /**
     * Skills the agent may load in this session: described, auto-invokable, and not denied by the
     * agent's rules or the session's effective policy. Contents still load through the host tool.
     */
    readonly skills: (input: {
      readonly sessionID: string
      readonly agent: string
    }) => Effect.Effect<readonly DelegatedSkillSummary[]>
    /**
     * The base prompt a native redsun agent would get for this session, built from the same
     * pure pieces (never a second run of the request hooks): the agent's custom prompt when it
     * has one, else the host's base prompt with guidance for `tools` (the host tool ids the
     * runtime serves) and the provider note native Anthropic requests carry. Fails when the
     * agent no longer exists.
     */
    readonly system: (input: {
      readonly sessionID: string
      readonly agent: string
      readonly tools: readonly string[]
    }) => Effect.Effect<DelegatedSystemPrompt, Error>
  }
  readonly transcript: {
    /**
     * Live context usage for the turn's host assistant message while the runtime's own loop runs,
     * shaped like the stream's `finish` usage. Not persisted: the `finish` part stays the recorded
     * value, so publish only what that part would report were the turn to end now.
     */
    readonly usage: (input: {
      readonly sessionID: string
      readonly messageID: string
      readonly usage: LanguageModelV3Usage
      /** The same entries the `finish` part's provider metadata would carry. */
      readonly native?: Record<string, unknown>
    }) => Effect.Effect<void>
    /**
     * A visible notice row that does not steer the running turn (unlike `session.synthetic`,
     * which is admitted to the inbox and would spend a model call).
     */
    readonly notice: (input: {
      readonly sessionID: string
      readonly text: string
      readonly description?: string
      readonly metadata?: Record<string, unknown>
    }) => Effect.Effect<void>
  }
}
