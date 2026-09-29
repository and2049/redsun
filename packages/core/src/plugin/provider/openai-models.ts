export * as OpenAIModels from "./openai-models.js"

import type { Credential } from "@opencode/schema/credential"
import { z } from "zod"

// REDSUN: the ChatGPT backend's per-model input windows, read from the catalog Codex CLI reads.

/**
 * The Codex CLI version the catalog is requested as. The backend requires one and lists only the
 * models that version supports (an old version gets none); a model missing from the catalog keeps
 * the fallback window.
 */
export const CLIENT_VERSION = "0.159.0"

/** Codex's own fallback input window, used until (or unless) the catalog lists the model. */
export const DEFAULT_INPUT = 272_000

/**
 * Output headroom on top of the input window, so the total stays at the 400K Codex models have
 * always reported by default.
 */
export const OUTPUT_RESERVE = 128_000

export type Setting = "default" | "max"

export interface Window {
  /** The backend's default input window. */
  readonly default: number
  /** The largest input window the backend allows; absent when it states none. */
  readonly max?: number
}

const Payload = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      context_window: z.number().int().positive().nullish(),
      max_context_window: z.number().int().positive().nullish(),
    }),
  ),
})

export function parseWindows(value: unknown): ReadonlyMap<string, Window> {
  return new Map(
    Payload.parse(value).models.flatMap((model): [string, Window][] => {
      const fallback = model.context_window ?? model.max_context_window
      if (!fallback) return []
      const max = model.max_context_window ? Math.max(model.max_context_window, fallback) : undefined
      return [[model.slug, max === undefined ? { default: fallback } : { default: fallback, max }]]
    }),
  )
}

export async function readWindows(
  credential: Credential.OAuth,
  baseURL: string,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Window>> {
  const accountID = credential.metadata?.accountID
  const response = await fetch(`${baseURL}/models?client_version=${CLIENT_VERSION}`, {
    signal,
    redirect: "error",
    headers: {
      authorization: `Bearer ${credential.access}`,
      originator: "opencode",
      ...(typeof accountID === "string" ? { "chatgpt-account-id": accountID } : {}),
    },
  })
  if (!response.ok) throw new Error(`ChatGPT model catalog request failed (${response.status})`)
  return parseWindows(await response.json())
}

/** The catalog reader the OpenAI plugin calls; tests replace `read` so they never reach the backend. */
export const reader = { read: readWindows }

/** A ChatGPT-plan model's limits under the selected window. */
export function limit(window: Window | undefined, setting: Setting) {
  const input = (setting === "max" ? window?.max : undefined) ?? window?.default ?? DEFAULT_INPUT
  return { context: input + OUTPUT_RESERVE, input }
}
