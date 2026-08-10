import type { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"

/** Provider id exposed to the model picker, task_router, and agent config. */
export const PROVIDER_ID = "claude-code"

/**
 * Sentinel npm identifier. Requests for this provider divert to the delegated
 * Claude Code runtime before any AI SDK resolution; if this name ever reaches
 * resolveSDK the load fails loudly instead of silently using a real SDK.
 */
export const SENTINEL_NPM = "@redsun/claude-code-delegated"

/** The single predicate every delegated-runtime gate keys on. */
export function isDelegated(model: { providerID: string }): boolean {
  return model.providerID === PROVIDER_ID
}

const LIMIT_200K = { context: 200_000, output: 64_000 }
const LIMIT_1M = { context: 1_000_000, output: 64_000 }
const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

function model(input: {
  name: string
  family: string
  limit: { context: number; output: number }
}): typeof ConfigProviderV1.Model.Type {
  return {
    name: input.name,
    family: input.family,
    attachment: false,
    reasoning: true,
    temperature: false,
    tool_call: true,
    cost: ZERO_COST,
    limit: input.limit,
    modalities: { input: ["text"], output: ["text"] },
  }
}

/**
 * Hand-maintained subscription model list. Ids are Claude Code model aliases
 * passed through to the CLI verbatim (`claude --model opus`), so they track
 * whatever the user's installed Claude Code maps them to. Costs are zero:
 * usage is covered by the subscription, not API billing.
 */
export const MODELS: Record<string, typeof ConfigProviderV1.Model.Type> = {
  opus: model({ name: "Claude Opus (Claude Code)", family: "claude-opus", limit: LIMIT_200K }),
  "opus[1m]": model({ name: "Claude Opus 1M (Claude Code)", family: "claude-opus", limit: LIMIT_1M }),
  sonnet: model({ name: "Claude Sonnet (Claude Code)", family: "claude-sonnet", limit: LIMIT_200K }),
  "sonnet[1m]": model({ name: "Claude Sonnet 1M (Claude Code)", family: "claude-sonnet", limit: LIMIT_1M }),
  haiku: model({ name: "Claude Haiku (Claude Code)", family: "claude-haiku", limit: LIMIT_200K }),
}

/** Redsun model id -> Claude Code CLI model string. Identity today by design. */
export function sdkModel(modelID: string): string {
  return modelID
}

export function providerConfig(): typeof ConfigProviderV1.Info.Type {
  return {
    name: "Anthropic (Claude Code)",
    npm: SENTINEL_NPM,
    models: MODELS,
  }
}

export * as ClaudeCodeModels from "./models"
