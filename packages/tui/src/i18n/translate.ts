import { catalog } from "./catalog"
import { ui } from "./ui"
import { session } from "./session"
import { settings } from "./settings"
import { application } from "./application"
import { remote } from "./remote"
import { ai } from "./ai"
import { activity } from "./activity"
import { tools } from "./tools"
import { upstreamAliases } from "./aliases"
import { locales, type Locale } from "./locale"

export const messages: Readonly<Record<string, readonly [string, string, string, string]>> = {
  ...ui,
  ...session,
  ...settings,
  ...application,
  ...remote,
  ...ai,
  ...activity,
  ...tools,
  ...catalog,
  ...Object.fromEntries(Object.entries(upstreamAliases).map(([message, source]) => [message, catalog[source]])),
}

export type Values = Readonly<Record<string, string | number>>

export function translate(locale: Locale, message: string, values?: Values): string {
  const index = locales.indexOf(locale) - 1
  const translated = Object.hasOwn(messages, message) ? messages[message]?.[index] : undefined
  return (translated || message).replace(/\{\{(\w+)\}\}/g, (token, key: string) =>
    values && Object.hasOwn(values, key) ? String(values[key]) : token,
  )
}
