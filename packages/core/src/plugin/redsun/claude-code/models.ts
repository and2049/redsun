export * as ClaudeCodeModels from "./models.js"

import { Model } from "../../../model.js"
import { Provider } from "../../../provider.js"

export const PROVIDER_ID = Provider.ID.make("claude-code")

export const SENTINEL_NAME = "@redsun/claude-code-delegated"

export const SENTINEL_PACKAGE = Provider.aisdk(SENTINEL_NAME)

export const DISPLAY_NAME = "Anthropic (Claude Code)"

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

export const MODELS = [
  model("fable", { name: "Claude Fable", family: "claude-fable", limit: CONTEXT_1M }),
  model("opus", { name: "Claude Opus", family: "claude-opus", limit: CONTEXT_200K }),
  model("opus[1m]", { name: "Claude Opus 1M", family: "claude-opus", limit: CONTEXT_1M }),
  model("sonnet", { name: "Claude Sonnet", family: "claude-sonnet", limit: CONTEXT_200K }),
  model("sonnet[1m]", { name: "Claude Sonnet 1M", family: "claude-sonnet", limit: CONTEXT_1M }),
  model("haiku", { name: "Claude Haiku", family: "claude-haiku", limit: CONTEXT_200K }),
] as const

export const cliModel = (modelID: string) => modelID

export const providerInfo = (): Provider.Info => ({
  id: PROVIDER_ID,
  name: DISPLAY_NAME,
  activation: "enabled",
  package: SENTINEL_PACKAGE,
})
