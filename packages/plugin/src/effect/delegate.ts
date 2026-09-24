import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { ToolDefinition } from "@opencode/ai"
import type { Form } from "@opencode/schema/form"
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
 * REDSUN: an external coding agent that runs its own agent loop behind a provider (Claude Code
 * through the Agent SDK, an ACP agent). The runtime owns model calls, its native transcript, native
 * tools and compaction; the host keeps sessions, UI, agent selection and permission policy.
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
   * (Claude Code: `/compact`). Omitted, the request fails with `notice` or a generic message.
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

export type DelegatedFormState = Exclude<Form.State, { readonly status: "pending" }>

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

export interface DelegateDomain {
  readonly register: (runtime: DelegatedRuntime) => Effect.Effect<Registration, never, Scope.Scope>
  /** Whether a registered runtime owns this model's agent loop. */
  readonly owns: (model: { readonly providerID: string }) => Effect.Effect<boolean>
  /** Live read of a top-level config key; the highest-priority document that sets it wins. */
  readonly config: (key: string) => Effect.Effect<unknown>
  readonly storage: (runtimeID: string) => DelegatedStorage
  readonly permission: {
    /** The effective decision without prompting; for mandatory policy checks. */
    readonly inspect: (
      input: DelegatedPermissionCheck,
    ) => Effect.Effect<{ readonly effect: Permission.Effect; readonly message?: string }>
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
  readonly form: {
    /** Shows a form in the session and waits for it to settle. */
    readonly ask: (input: {
      readonly sessionID: string
      readonly title: string
      readonly metadata?: Record<string, unknown>
      readonly fields: readonly Form.Field[]
    }) => Effect.Effect<DelegatedFormState>
  }
}
