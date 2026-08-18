// REDSUN: the Claude Code delegated provider's model registry.
//
// Mirrors V1: an autodetected "Anthropic (Claude Code)" provider whose model ids
// are Claude Code CLI aliases passed through verbatim, so they track whatever the
// user's installed CLI maps them to. Cost is zero because usage is covered by the
// user's subscription, not API billing.
export * as ClaudeCodeModels from "./models.js"

import { Model } from "../../../model.js"
import { Provider } from "../../../provider.js"

/** Provider id exposed to the model picker, agent config, and subagent routing. */
export const PROVIDER_ID = Provider.ID.make("claude-code")

/**
 * Sentinel package identifier. Requests for this provider are answered by the
 * delegated language model, so this name must never reach real SDK resolution —
 * if it does, the load fails loudly instead of silently using another provider.
 */
export const SENTINEL_PACKAGE = "@redsun/claude-code-delegated"

export const DISPLAY_NAME = "Anthropic (Claude Code)"

/** The single predicate every delegated gate keys on. */
export const isDelegated = (model: { readonly providerID: string }) => model.providerID === PROVIDER_ID

const CONTEXT_200K = { context: 200_000, output: 64_000 }
const CONTEXT_1M = { context: 1_000_000, output: 64_000 }

const model = (id: string, input: { name: string; family: string; limit: { context: number; output: number } }) => ({
  ...Model.Info.default(PROVIDER_ID, Model.ID.make(id)),
  name: input.name,
  family: Model.Family.make(input.family),
  package: SENTINEL_PACKAGE,
  capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
  limit: input.limit,
})

/**
 * Hand-maintained subscription model list. `fable` is Max-plan only; Pro accounts
 * selecting it get the CLI's own access error at request time rather than a
 * redsun-side rejection, so the list stays honest about what the CLI accepts.
 */
export const MODELS = [
  model("fable", { name: "Claude Fable", family: "claude-fable", limit: CONTEXT_1M }),
  model("opus", { name: "Claude Opus", family: "claude-opus", limit: CONTEXT_200K }),
  model("opus[1m]", { name: "Claude Opus 1M", family: "claude-opus", limit: CONTEXT_1M }),
  model("sonnet", { name: "Claude Sonnet", family: "claude-sonnet", limit: CONTEXT_200K }),
  model("sonnet[1m]", { name: "Claude Sonnet 1M", family: "claude-sonnet", limit: CONTEXT_1M }),
  model("haiku", { name: "Claude Haiku", family: "claude-haiku", limit: CONTEXT_200K }),
] as const

/** Redsun model id -> Claude Code CLI `--model` string. Identity today by design. */
export const cliModel = (modelID: string) => modelID

/**
 * `enabled`, not `auto`: auth.ts registers a `claude-code` integration, and
 * catalog.ts hides an `auto` provider that has an integration with no
 * connections. Autodetection is the contract here — the provider appears
 * whenever the binary resolves, and connecting is opt-in identity verification
 * rather than a gate. The plugin only registers any of this after the
 * executable resolves, so `enabled` never means "always on".
 */
export const providerInfo = (): Provider.Info => ({
  id: PROVIDER_ID,
  name: DISPLAY_NAME,
  activation: "enabled",
  package: SENTINEL_PACKAGE,
})
