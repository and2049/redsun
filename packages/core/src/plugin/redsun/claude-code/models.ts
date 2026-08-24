export * as ClaudeCodeModels from "./models.js"

import { Model } from "../../../model.js"
import { Provider } from "../../../provider.js"

export const PROVIDER_ID = Provider.ID.make("claude-code")

export const SENTINEL_NAME = "@redsun/claude-code-delegated"

export const SENTINEL_PACKAGE = Provider.aisdk(SENTINEL_NAME)

export const DISPLAY_NAME = "Anthropic (Claude Code)"

// Synthetic-notice metadata key for a silent CLI model substitution; the TUI
// colors notices carrying it (SessionNoticeMessageV2 duplicates the literal).
export const SUBSTITUTED_METADATA_KEY = "redsun.claude-code.model-substituted"

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
  // Pinned previous-generation ids the CLI accepts verbatim. Aliases stay
  // first: `catalog.model.small` picks the first claude-haiku-family model.
  model("claude-opus-4-8", { name: "Claude Opus 4.8", family: "claude-opus", limit: CONTEXT_1M }),
  model("claude-sonnet-4-5", { name: "Claude Sonnet 4.5", family: "claude-sonnet", limit: CONTEXT_200K }),
  model("claude-haiku-4-5", { name: "Claude Haiku 4.5", family: "claude-haiku", limit: CONTEXT_200K }),
] as const

export const cliModel = (modelID: string) => modelID

// The CLI accepts any model string and, when the id is unknown or not on the
// user's plan, silently serves its default instead of failing. Aliases (and
// their `[1m]` variants) resolve to some concrete model by design, so only a
// pinned `claude-*` id makes "which model answered" checkable; a dated
// snapshot of the requested pin still counts as served.
export const isSubstituted = (requested: string, served: string) => {
  const pin = requested.replace(/\[[^\]]*\]$/, "")
  if (!pin.startsWith("claude-")) return false
  if (!served) return false
  return served !== pin && !served.startsWith(pin + "-")
}

// Structural subset of both the plugin context's CatalogDraft and core's
// Catalog.Draft (method syntax keeps the id brands bivariant), so the same
// registration runs from provider.ts and from a test driving a real Catalog.
type CatalogTarget = {
  readonly provider: { update(providerID: Provider.ID, fn: (provider: Provider.MutableInfo) => void): void }
  readonly model: { update(providerID: Provider.ID, modelID: Model.ID, fn: (model: Model.MutableInfo) => void): void }
}

export const applyCatalog = (catalog: CatalogTarget) => {
  const info = providerInfo()
  catalog.provider.update(PROVIDER_ID, (provider) => {
    provider.name = info.name
    provider.activation = info.activation
    provider.package = info.package
  })
  for (const entry of MODELS) {
    catalog.model.update(PROVIDER_ID, entry.id, (draft) => {
      Object.assign(draft, entry)
    })
  }
}

export const providerInfo = (): Provider.Info => ({
  id: PROVIDER_ID,
  name: DISPLAY_NAME,
  activation: "enabled",
  package: SENTINEL_PACKAGE,
})
