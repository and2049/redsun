import type { Catalog, Message } from "@opencode/plugin/tui/i18n"
import manifest from "./manifest.json"

export interface SourceEntry {
  readonly message: Message
  readonly context: string
  readonly legacy: readonly string[]
  readonly upstream?: { readonly key: string; readonly pin: string; readonly match: string }
}

export const source: Readonly<Record<string, SourceEntry>> = manifest.messages
export const english: Catalog = Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, entry.message]))
export const sourceIDs = new Map(
  Object.entries(source).flatMap(([key, entry]) => entry.legacy.map((text) => [text, key] as const)),
)

export function sourceKey(key: string): string {
  const id = Object.hasOwn(source, key) ? key : sourceIDs.get(key)
  return id ? `tui:${id}` : key.includes(":") ? key : `tui:${key}`
}
