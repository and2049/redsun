import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { Effect, Scope } from "effect"
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

export interface DelegateDomain {
  readonly register: (runtime: DelegatedRuntime) => Effect.Effect<Registration, never, Scope.Scope>
  /** Whether a registered runtime owns this model's agent loop. */
  readonly owns: (model: { readonly providerID: string }) => Effect.Effect<boolean>
}
