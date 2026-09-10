import type { Values } from "@opencode/plugin/tui/i18n"
import { interpolate, resolveCatalogs } from "./registry"
import { source, sourceIDs, sourceKey } from "./source"

export type { Values }
export type Translator = (key: string, values?: Values) => string

const fallback = resolveCatalogs([])

export function translate(message: string, values?: Values): string {
  if (!message.includes(":") && !Object.hasOwn(source, message) && !sourceIDs.has(message))
    return interpolate(message, values)
  return fallback.t("en", sourceKey(message), values)
}
