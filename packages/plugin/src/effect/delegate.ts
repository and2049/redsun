import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

/**
 * REDSUN: an external coding agent that runs its own agent loop behind a provider (Claude Code
 * through the Agent SDK, an ACP agent). The runtime owns model calls, its native transcript, native
 * tools and compaction; the host keeps sessions, UI, agent selection and permission policy.
 */
export interface DelegatedRuntime {
  readonly id: string
  /** Every model of this provider is delegated to the runtime. */
  readonly providerID: string
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
