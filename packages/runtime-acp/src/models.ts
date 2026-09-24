export * as AcpModels from "./models.js"

import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk"

// An agent's own model list and how to switch it. ACP standardised model selection as a session
// config option with category "model"; agents that predate it (Kiro 2.23) report an unstable
// `models` field and take `session/set_model`.

export interface Discovered {
  readonly id: string
  readonly name: string
  readonly description?: string
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

/** The model selector a session response or config update carries, if any. */
export const fromConfig = (options: ReadonlyArray<SessionConfigOption> | null | undefined): State | undefined => {
  const selector = options?.find((option) => option.category === "model" && option.type === "select")
  if (!selector || selector.type !== "select") return undefined
  return {
    models: flat(selector.options).map((option) => ({
      id: option.value,
      name: option.name || option.value,
      ...(option.description ? { description: option.description } : {}),
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
