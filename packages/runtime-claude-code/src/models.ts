export * as ClaudeCodeModels from "./models.js"

import type { Types } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Delegate } from "@opencode/schema/delegate"
import type { ClaudeCodeSessions } from "./sessions.js"
import type { Options } from "@anthropic-ai/claude-agent-sdk"

export const PROVIDER_ID = Provider.ID.make("claude-code")

export const SENTINEL_NAME = "@redsun/claude-code-delegated"

export const SENTINEL_PACKAGE = `aisdk:${SENTINEL_NAME}`

export const DISPLAY_NAME = "Anthropic (Claude Code)"

// Synthetic-notice metadata key for a silent CLI model substitution; the TUI colors notices
// carrying it.
export const SUBSTITUTED_METADATA_KEY = Delegate.MODEL_SUBSTITUTED_METADATA_KEY

export const isDelegated = (model: { readonly providerID: string }) => model.providerID === PROVIDER_ID

const CONTEXT_200K = 200_000
const CONTEXT_1M = 1_000_000

// "claude-sonnet-5" → 5, "claude-haiku-4-5-20251001" → 4.5; the second digit
// only counts when it is a single one, so a dated snapshot's date never reads
// as a version.
const GENERATION = /^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?(?:-|$)/

// The first generation of each family that runs with a native 1M window on
// every plan (Claude Code model-config docs, "Extended context"; matches the
// windows CLI 2.1.284 reports).
// Older generations reach 1M only through their `[1m]` variant.
const NATIVE_1M: Record<string, readonly [major: number, minor: number]> = {
  fable: [0, 0],
  opus: [4, 7],
  sonnet: [5, 0],
}

/**
 * The context window Claude Code runs a wire model id with. With
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` it holds every model to 200K.
 */
export const contextWindow = (id: string, disable1M = false) => {
  if (disable1M) return CONTEXT_200K
  if (id.endsWith("[1m]")) return CONTEXT_1M
  const match = GENERATION.exec(id)
  const since = match ? NATIVE_1M[match[1]!] : undefined
  if (!match || !since) return CONTEXT_200K
  const major = Number(match[2])
  const minor = Number(match[3] ?? 0)
  return major > since[0] || (major === since[0] && minor >= since[1]) ? CONTEXT_1M : CONTEXT_200K
}

const model = (id: string, input: { name: string; family: string; context: number }) => ({
  ...Model.Info.default(PROVIDER_ID, Model.ID.make(id)),
  name: input.name,
  family: Model.Family.make(input.family),
  package: SENTINEL_PACKAGE,
  capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
  limit: { context: input.context, output: 64_000 },
})

const pin = (id: string, name: string, family: string) => model(id, { name, family, context: contextWindow(id) })

// Bare family aliases; each may also take a `[1m]` suffix.
const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const

export const MODELS = [
  // Alias windows are those of the Anthropic API resolutions until the CLI's
  // picker says what an alias runs (see `applyCatalog`).
  model("fable", { name: "Claude Fable", family: "claude-fable", context: CONTEXT_1M }),
  model("opus", { name: "Claude Opus", family: "claude-opus", context: CONTEXT_1M }),
  model("opus[1m]", { name: "Claude Opus 1M", family: "claude-opus", context: CONTEXT_1M }),
  model("sonnet", { name: "Claude Sonnet", family: "claude-sonnet", context: CONTEXT_1M }),
  model("sonnet[1m]", { name: "Claude Sonnet 1M", family: "claude-sonnet", context: CONTEXT_1M }),
  model("haiku", { name: "Claude Haiku", family: "claude-haiku", context: CONTEXT_200K }),
  // Version pins explicitly documented by Claude Code, plus older curated ids.
  // A pin is selectable, not a claim that this subscription can serve it.
  // Aliases stay
  // first: `catalog.model.small` picks the first claude-haiku-family model.
  pin("claude-fable-5-1", "Claude Fable 5.1", "claude-fable"),
  pin("claude-fable-5", "Claude Fable 5", "claude-fable"),
  pin("claude-opus-5-5", "Claude Opus 5.5", "claude-opus"),
  pin("claude-sonnet-5-5", "Claude Sonnet 5.5", "claude-sonnet"),
  pin("claude-opus-4-8", "Claude Opus 4.8", "claude-opus"),
  pin("claude-sonnet-4-5", "Claude Sonnet 4.5", "claude-sonnet"),
  pin("claude-haiku-4-5", "Claude Haiku 4.5", "claude-haiku"),
] as const

export const cliModel = (modelID: string) => modelID

const stripVariant = (id: string) => id.replace(/\[[^\]]*\]$/, "")

// The same model, ignoring a `[1m]` variant and a dated snapshot suffix.
const sameModel = (a: string, b: string) => {
  const base = (id: string) => stripVariant(id).replace(/-\d{8}$/, "")
  return base(a) === base(b)
}

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
  update(providerID: Provider.ID, fn: (provider: Types.DeepMutable<Provider.Info>) => void): void
  readonly models: {
    update(providerID: Provider.ID, modelID: Model.ID, fn: (model: Types.DeepMutable<Model.Info>) => void): void
  }
}

export const applyCatalog = (
  providers: ProviderTarget,
  extras?: {
    readonly retired?: ReadonlyMap<string, Retirement>
    readonly discovered?: readonly Discovered[]
    /** `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set for the CLI. */
    readonly disable1M?: boolean
  },
) => {
  const info = providerInfo()
  providers.update(PROVIDER_ID, (provider) => {
    provider.name = info.name
    provider.activation = info.activation
    provider.package = info.package
  })
  const disable1M = extras?.disable1M ?? false
  const curated = new Set(MODELS.map((entry) => String(entry.id)))
  // What each listed id runs on the wire, where known: a pin runs itself, an
  // alias whatever the CLI resolves it to.
  const wire = new Map<string, string>()
  for (const entry of MODELS) {
    providers.models.update(PROVIDER_ID, entry.id, (draft) => {
      Object.assign(draft, entry)
    })
    if (entry.id.startsWith("claude-")) wire.set(entry.id, entry.id)
  }
  // An exact alias row wins. Otherwise a sibling variant, or a newest
  // unambiguous versioned picker row, resolves the missing family alias, and
  // its `[1m]` variant runs the same model with the 1M window.
  const rows = extras?.discovered ?? []
  const exact = (id: string) => rows.some((entry) => entry.value === id)
  for (const family of FAMILIES) {
    const target = rows.find((entry) => entry.value === family)?.resolvedModel ?? aliasGeneration(family, rows)
    if (!target) continue
    for (const [id, resolvedModel] of [
      [family, target],
      [`${family}[1m]`, `${stripVariant(target)}[1m]`],
    ] as const) {
      if (!curated.has(id) || exact(id)) continue
      wire.set(id, resolvedModel)
      const name = discoveredName({ value: id, resolvedModel })
      if (name) providers.models.update(PROVIDER_ID, Model.ID.make(id), (draft) => void (draft.name = name))
    }
  }
  // The CLI's own picker rows: refresh a curated alias's name to the served
  // generation, append rows the CLI grew that we don't curate. "default"
  // duplicates whatever it resolves to, so it is skipped.
  for (const found of rows) {
    if (found.value === "default") continue
    const target = found.resolvedModel ?? found.value
    wire.set(found.value, isOneMillion(found) && !target.endsWith("[1m]") ? `${target}[1m]` : target)
    const name = discoveredName(found)
    if (curated.has(found.value)) {
      if (name) providers.models.update(PROVIDER_ID, Model.ID.make(found.value), (draft) => void (draft.name = name))
      continue
    }
    const entry = model(found.value, {
      name: name ?? found.value,
      family: discoveredFamily(found),
      context: CONTEXT_200K,
    })
    providers.models.update(PROVIDER_ID, entry.id, (draft) => {
      Object.assign(draft, entry)
    })
  }
  // Size every model by what it runs. A model that runs what a bare alias
  // runs, with the same window, is that alias's duplicate: `claude-fable-5-1`
  // while `fable` resolves to it, or `opus[1m]` while `opus` is natively 1M.
  // It stays resolvable for sessions and config, just not listed.
  const aliases = FAMILIES.flatMap((family) => {
    const target = wire.get(family)
    return target ? [{ family, target, context: contextWindow(target, disable1M) }] : []
  })
  for (const id of new Set([...curated, ...rows.map((entry) => entry.value).filter((id) => id !== "default")])) {
    const target = wire.get(id)
    const context = target ? contextWindow(target, disable1M) : disable1M ? CONTEXT_200K : undefined
    const duplicate =
      target !== undefined &&
      aliases.some((alias) => alias.family !== id && sameModel(alias.target, target) && alias.context === context)
    // The CLI drops 1M variants from its picker when 1M context is disabled.
    const hidden = duplicate || (disable1M && id.endsWith("[1m]"))
    if (context === undefined && !hidden) continue
    providers.models.update(PROVIDER_ID, Model.ID.make(id), (draft) => {
      if (context !== undefined) draft.limit = { ...draft.limit, context }
      if (hidden) draft.enabled = false
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
