export * as AcpModels from "./models.js"

import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk"

// An agent's own model list and how to switch it. ACP standardised model selection as a session
// config option with category "model"; agents that predate it (Kiro 2.23) report an unstable
// `models` field and take `session/set_model`.

export interface Discovered {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** The reasoning-effort levels the agent offers for this model, in its order (Kiro `_meta`). */
  readonly efforts?: readonly string[]
  /** The level a session gets when it switches to this model. */
  readonly defaultEffort?: string
}

/** A session's live reasoning-effort selector (category `thought_level`), when it has one. */
export interface Effort {
  readonly configId: string
  readonly options: readonly string[]
  readonly current?: string
}

export type Control = { readonly kind: "config"; readonly configId: string } | { readonly kind: "legacy" }

export interface State {
  readonly models: readonly Discovered[]
  readonly current?: string
  readonly control?: Control
}

/** The `models` field of the unstable protocol, `session/set_model`'s counterpart. */
export const LEGACY_SET_MODEL = "session/set_model"

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const flat = (options: ReadonlyArray<unknown>): SessionConfigSelectOption[] =>
  options.flatMap((item) => {
    const entry = record(item)
    if (Array.isArray(entry?.options)) return flat(entry.options)
    return typeof entry?.value === "string" ? [entry as unknown as SessionConfigSelectOption] : []
  })

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []

/** Kiro describes each model option's effort levels in `_meta.kiro`; other agents don't. */
const efforts = (option: SessionConfigSelectOption) => {
  const kiro = record(record(option._meta)?.kiro)
  const levels = strings(kiro?.effortLevels)
  if (!levels.length) return {}
  const fallback = kiro?.defaultEffortLevel
  return {
    efforts: levels,
    ...(typeof fallback === "string" && levels.includes(fallback) ? { defaultEffort: fallback } : {}),
  }
}

/** The effort selector in a full config-option list; none when the current model has no levels. */
export const effort = (options: ReadonlyArray<SessionConfigOption> | null | undefined): Effort | undefined => {
  const selector = options?.find((option) => option.category === "thought_level" && option.type === "select")
  if (!selector || selector.type !== "select") return undefined
  return {
    configId: selector.id,
    options: flat(selector.options).map((option) => option.value),
    current: selector.currentValue,
  }
}

/** The model selector a session response or config update carries, if any. */
export const fromConfig = (options: ReadonlyArray<SessionConfigOption> | null | undefined): State | undefined => {
  const selector = options?.find((option) => option.category === "model" && option.type === "select")
  if (!selector || selector.type !== "select") return undefined
  return {
    models: flat(selector.options).map((option) => ({
      id: option.value,
      name: option.name || option.value,
      ...(option.description ? { description: option.description } : {}),
      ...efforts(option),
    })),
    current: selector.currentValue,
    control: { kind: "config", configId: selector.id },
  }
}

const fromLegacy = (value: unknown): State | undefined => {
  const models = record(value)
  if (!models || !Array.isArray(models.availableModels)) return undefined
  return {
    models: models.availableModels.flatMap((item) => {
      const entry = record(item)
      const id = typeof entry?.modelId === "string" && entry.modelId ? entry.modelId : undefined
      if (!id) return []
      const name = typeof entry?.name === "string" && entry.name ? entry.name : id
      const description = typeof entry?.description === "string" && entry.description ? entry.description : undefined
      return [{ id, name, ...(description ? { description } : {}) }]
    }),
    ...(typeof models.currentModelId === "string" ? { current: models.currentModelId } : {}),
    control: { kind: "legacy" },
  }
}

/** Reads a `session/new` or `session/load` response; the standard selector wins. */
export const read = (response: unknown): State | undefined => {
  const value = record(response)
  return (
    fromConfig(value?.configOptions as ReadonlyArray<SessionConfigOption> | null | undefined) ??
    fromLegacy(value?.models)
  )
}
