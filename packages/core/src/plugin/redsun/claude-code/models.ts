export * as ClaudeCodeModels from "./models.js"

import { Model } from "../../../model.js"
import { Provider } from "../../../provider.js"
import type { ClaudeCodeSessions } from "./sessions.js"
import type { Options } from "@anthropic-ai/claude-agent-sdk"

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
  // Version pins explicitly documented by Claude Code, plus older curated ids.
  // A pin is selectable, not a claim that this subscription can serve it.
  // Aliases stay
  // first: `catalog.model.small` picks the first claude-haiku-family model.
  model("claude-fable-5-1", { name: "Claude Fable 5.1", family: "claude-fable", limit: CONTEXT_1M }),
  model("claude-fable-5", { name: "Claude Fable 5", family: "claude-fable", limit: CONTEXT_1M }),
  model("claude-opus-5-5", { name: "Claude Opus 5.5", family: "claude-opus", limit: CONTEXT_200K }),
  model("claude-opus-4-8", { name: "Claude Opus 4.8", family: "claude-opus", limit: CONTEXT_1M }),
  model("claude-sonnet-4-5", { name: "Claude Sonnet 4.5", family: "claude-sonnet", limit: CONTEXT_200K }),
  model("claude-haiku-4-5", { name: "Claude Haiku 4.5", family: "claude-haiku", limit: CONTEXT_200K }),
] as const

export const cliModel = (modelID: string) => modelID

const stripVariant = (id: string) => id.replace(/\[[^\]]*\]$/, "")

// The CLI accepts any model string and, when the id is unknown or not on the
// user's plan, silently serves its default instead of failing. A pinned
// `claude-*` id makes "which model answered" checkable directly; an alias is
// only checkable when the CLI's own picker (`supportedModels()`) told us what
// it resolves to. A dated snapshot of the expected model still counts as
// served.
export const isSubstituted = (requested: string, served: string, resolved?: string) => {
  if (!served) return false
  const pin = stripVariant(requested)
  if (pin.startsWith("claude-")) return served !== pin && !served.startsWith(pin + "-")
  const target = resolved ? stripVariant(resolved) : ""
  if (!target.startsWith("claude-")) return false
  return served !== target && !served.startsWith(target + "-")
}

// Only curated pinned ids retire: aliases always resolve to something, and
// config-added ids are the user's own escape hatch to leave alone.
export const isRetirable = (id: string) => id.startsWith("claude-") && MODELS.some((entry) => String(entry.id) === id)

export interface Retirement {
  readonly served: string
  readonly at?: string
}

// One row of the CLI's `/model` picker, as `supportedModels()` reports it.
// The picker is not the accepted-alias list (bare `opus` works but is not
// listed), so discovered rows only add or refresh entries, never remove.
export interface Discovered {
  readonly value: string
  readonly resolvedModel?: string
  readonly displayName?: string
}

export const parseDiscovered = (value: unknown): Discovered[] => {
  if (!Array.isArray(value)) return []
  const result: Discovered[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const record = item as { value?: unknown; resolvedModel?: unknown; displayName?: unknown }
    if (typeof record.value !== "string" || !record.value) continue
    result.push({
      value: record.value,
      ...(typeof record.resolvedModel === "string" && record.resolvedModel
        ? { resolvedModel: record.resolvedModel }
        : {}),
      ...(typeof record.displayName === "string" && record.displayName ? { displayName: record.displayName } : {}),
    })
  }
  return result
}

// Preserve location-scoped model settings while making the initialization-only
// process inert: the CLI otherwise runs SessionStart hooks, launches inherited
// MCP servers and writes a native session before receiving any user prompt.
export const metadataOptions = (options: Options): Options => ({
  ...options,
  settingSources: ["user", "project", "local"],
  settings: { disableAllHooks: true },
  strictMcpConfig: true,
  persistSession: false,
})

// The SDK exposes the CLI's picker in its initialize control response. An
// idle streaming query never submits a user message or makes a model request.
export const probe = async (
  createQuery: ClaudeCodeSessions.CreateQuery,
  options: Options,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<Discovered[]> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => controller.abort()
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  let query: ClaudeCodeSessions.QueryLike | undefined
  try {
    if (controller.signal.aborted) return []
    query = createQuery({
      prompt: (async function* () {
        if (!controller.signal.aborted)
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true }),
          )
      })(),
      options: { ...options, abortController: controller },
    })
    const models = await Promise.race([
      query.supportedModels?.() ?? Promise.resolve([]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code model discovery timed out")), timeoutMs)
        controller.signal.addEventListener("abort", () => reject(new Error("Claude Code model discovery cancelled")), {
          once: true,
        })
      }),
    ])
    return parseDiscovered(models)
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
    query?.close()
    signal?.removeEventListener("abort", cancel)
  }
}

export const parseRetired = (value: unknown): Map<string, Retirement> => {
  const result = new Map<string, Retirement>()
  if (!value || typeof value !== "object" || Array.isArray(value)) return result
  for (const [id, record] of Object.entries(value)) {
    if (!record || typeof record !== "object") continue
    const served = (record as { served?: unknown }).served
    const at = (record as { at?: unknown }).at
    if (typeof served !== "string" || !served) continue
    result.set(id, { served, ...(typeof at === "string" ? { at } : {}) })
  }
  return result
}

// "claude-sonnet-5" → 5, "claude-haiku-4-5-20251001" → 4.5; the second digit
// only counts when it is a single one, so a dated snapshot's date never reads
// as a version.
const GENERATION = /^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?(?:-|$)/

const isOneMillion = (entry: Discovered) => entry.value.endsWith("[1m]") || (entry.resolvedModel ?? "").endsWith("[1m]")

export const discoveredName = (entry: Discovered): string | undefined => {
  const match = GENERATION.exec(stripVariant(entry.resolvedModel ?? "")) ?? GENERATION.exec(stripVariant(entry.value))
  const fallback = entry.displayName?.trim().replace(/^Claude\s+/i, "")
  const name = match
    ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[3] ? `${match[2]}.${match[3]}` : match[2]}`
    : fallback
  if (!name) return undefined
  const variant = isOneMillion(entry) && !/\b1\s?m\b/i.test(name) ? " 1M" : ""
  const latest =
    match &&
    (/(?:^|\s)\(latest\)/i.test(fallback ?? "") ||
      stripVariant(entry.value) === match[1] ||
      stripVariant(entry.value) === `claude-${match[1]}`)
      ? " (latest)"
      : ""
  return `Claude ${name}${variant}${latest}`
}

const discoveredFamily = (entry: Discovered): string => {
  const resolved = stripVariant(entry.resolvedModel ?? "")
  const source = resolved.startsWith("claude-")
    ? resolved
    : `claude-${stripVariant(entry.value).replace(/^claude-/, "")}`
  const match = /^claude-([a-z]+)/.exec(source)
  return match ? `claude-${match[1]}` : "claude"
}

// Resolve a missing bare alias label from CLI picker evidence only. A sibling
// alias is strongest (`opus[1m]` speaks for `opus`'s generation, not its
// context window); otherwise use the newest comparable versioned row. Equal
// versions with different wire ids are ambiguous and leave the alias generic.
const aliasGeneration = (family: string, rows: readonly Discovered[]): string | undefined => {
  const candidate = (entry: Discovered) => {
    const pin = stripVariant(entry.resolvedModel ?? entry.value)
    const match = GENERATION.exec(pin)
    if (!match || match[1] !== family) return
    return { pin, major: Number(match[2]), minor: Number(match[3] ?? 0) }
  }
  const siblings = rows
    .filter((entry) => stripVariant(entry.value) === family && entry.value !== family && entry.resolvedModel)
    .map(candidate)
    .filter((item) => item !== undefined)
  const pool = siblings.length
    ? siblings
    : rows
        .filter((entry) => stripVariant(entry.value).startsWith(`claude-${family}-`))
        .map((entry) => {
          const value = candidate({ value: entry.value })
          const resolved = candidate(entry)
          return value && resolved && value.major === resolved.major && value.minor === resolved.minor
            ? resolved
            : undefined
        })
        .filter((item) => item !== undefined)
  if (!pool.length) return
  if (
    siblings.length &&
    siblings.some((item) => item.major !== siblings[0]!.major || item.minor !== siblings[0]!.minor)
  )
    return
  const sorted = pool.sort((a, b) => b.major - a.major || b.minor - a.minor)
  const best = sorted[0]!
  if (sorted.some((item) => item.major === best.major && item.minor === best.minor && item.pin !== best.pin)) return
  return best.pin
}

// Structural subset of both the plugin context's ProviderEditor and core's
// Provider.Editor (method syntax keeps the id brands bivariant), so the same
// registration runs from provider.ts and from a test driving a real registry.
type ProviderTarget = {
  update(providerID: Provider.ID, fn: (provider: Provider.MutableInfo) => void): void
  readonly models: {
    update(providerID: Provider.ID, modelID: Model.ID, fn: (model: Model.MutableInfo) => void): void
  }
}

export const applyCatalog = (
  providers: ProviderTarget,
  extras?: {
    readonly retired?: ReadonlyMap<string, Retirement>
    readonly discovered?: readonly Discovered[]
  },
) => {
  const info = providerInfo()
  providers.update(PROVIDER_ID, (provider) => {
    provider.name = info.name
    provider.activation = info.activation
    provider.package = info.package
  })
  const curated = new Set(MODELS.map((entry) => String(entry.id)))
  for (const entry of MODELS) {
    providers.models.update(PROVIDER_ID, entry.id, (draft) => {
      Object.assign(draft, entry)
    })
  }
  // An exact alias row wins. Otherwise a sibling variant, or a newest
  // unambiguous versioned picker row, labels the missing family alias without
  // changing its model id or context capabilities.
  const rows = extras?.discovered ?? []
  for (const family of ["fable", "opus", "sonnet", "haiku"]) {
    if (rows.some((entry) => entry.value === family)) continue
    const resolvedModel = aliasGeneration(family, rows)
    const name = resolvedModel && discoveredName({ value: family, resolvedModel })
    if (name) providers.models.update(PROVIDER_ID, Model.ID.make(family), (draft) => void (draft.name = name))
  }
  // The CLI's own picker rows: refresh a curated alias's name to the served
  // generation, append rows the CLI grew that we don't curate. "default"
  // duplicates whatever it resolves to, so it is skipped.
  for (const found of rows) {
    if (found.value === "default") continue
    const name = discoveredName(found)
    if (curated.has(found.value)) {
      if (name) providers.models.update(PROVIDER_ID, Model.ID.make(found.value), (draft) => void (draft.name = name))
      continue
    }
    const entry = model(found.value, {
      name: name ?? found.value,
      family: discoveredFamily(found),
      limit: isOneMillion(found) ? CONTEXT_1M : CONTEXT_200K,
    })
    providers.models.update(PROVIDER_ID, entry.id, (draft) => {
      Object.assign(draft, entry)
    })
  }
  // A pinned id the CLI was observed substituting is hidden until user config
  // (which runs after this transform) says otherwise.
  for (const id of extras?.retired?.keys() ?? []) {
    if (!curated.has(id)) continue
    providers.models.update(PROVIDER_ID, Model.ID.make(id), (draft) => void (draft.enabled = false))
  }
}

export const providerInfo = (): Provider.Info => ({
  id: PROVIDER_ID,
  name: DISPLAY_NAME,
  activation: "enabled",
  package: SENTINEL_PACKAGE,
})
