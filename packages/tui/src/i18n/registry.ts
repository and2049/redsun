import type {
  Catalog,
  LanguageContribution,
  LanguageInfo,
  Message,
  TranslationDiagnostic,
  Values,
} from "@opencode/plugin/tui/i18n"
import { canonicalLocale } from "./locale"
import { english } from "./source"

export interface Contribution {
  readonly plugin: string
  readonly value: LanguageContribution
}

const categories = new Set(["zero", "one", "two", "few", "many", "other"])
const parameters = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])
const texts = (message: Message) => (typeof message === "string" ? [message] : Object.values(message.forms))
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

export function validMessage(value: unknown): value is Message {
  if (typeof value === "string") return value.trim().length > 0
  return (
    record(value) &&
    typeof value.plural === "string" &&
    /^\w+$/.test(value.plural) &&
    record(value.forms) &&
    typeof value.forms.other === "string" &&
    Object.entries(value.forms).every(
      ([key, text]) => categories.has(key) && typeof text === "string" && text.trim().length > 0,
    )
  )
}

export function normalizeContribution(input: LanguageContribution): LanguageContribution {
  if (!record(input) || typeof input.locale !== "string" || !record(input.catalogs))
    throw new Error("Invalid language contribution")
  const locale = canonicalLocale(input.locale)
  if ((input.name === undefined) !== (input.nativeName === undefined))
    throw new Error("Language name and nativeName must be provided together")
  for (const field of ["name", "nativeName"] as const) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || !input[field].trim()))
      throw new Error(`Invalid language ${field}`)
  }
  const fallback = input.fallback === undefined ? undefined : canonicalLocale(input.fallback)
  const catalogs = Object.fromEntries(
    Object.entries(input.catalogs).map(([namespace, catalog]) => {
      if (!namespace || namespace.includes(":") || !record(catalog))
        throw new Error("Invalid translation namespace or catalog")
      return [namespace, structuredClone(catalog)]
    }),
  )
  return { locale, name: input.name, nativeName: input.nativeName, fallback, catalogs }
}

function compatible(message: Message, original: Message): boolean {
  if (typeof message !== typeof original) return false
  if (typeof message !== "string" && typeof original !== "string" && message.plural !== original.plural) return false
  const expected = new Set(texts(original).flatMap(parameters))
  const optional = typeof original === "string" ? undefined : original.plural
  return texts(message).every((text) => {
    const actual = new Set(parameters(text))
    return (
      [...actual].every((key) => expected.has(key)) && [...expected].every((key) => key === optional || actual.has(key))
    )
  })
}

export function resolveCatalogs(contributions: readonly Contribution[]) {
  const defaults = new Map<string, Message>(Object.entries(english).map(([key, message]) => [`tui:${key}`, message]))
  const diagnostics: TranslationDiagnostic[] = []
  const metadata = new Map<string, { name: string; nativeName: string; fallback?: string }>([
    ["en", { name: "English", nativeName: "English" }],
  ])
  const providers = new Map<string, Set<string>>()
  const catalogs = new Map<string, Map<string, Message>>()
  for (const { value } of contributions) {
    if (value.locale !== "en") continue
    for (const [namespace, catalog] of Object.entries(value.catalogs)) {
      if (namespace === "tui") continue
      for (const [key, message] of Object.entries(catalog))
        if (validMessage(message)) defaults.set(`${namespace}:${key}`, message)
    }
  }
  for (const { plugin, value } of contributions) {
    if (value.name && value.nativeName && value.locale !== "en")
      metadata.set(value.locale, { name: value.name, nativeName: value.nativeName, fallback: value.fallback })
    const owners = providers.get(value.locale) ?? new Set<string>()
    owners.add(plugin)
    providers.set(value.locale, owners)
    const messages = catalogs.get(value.locale) ?? new Map<string, Message>()
    catalogs.set(value.locale, messages)
    for (const [namespace, catalog] of Object.entries(value.catalogs)) {
      for (const [id, message] of Object.entries(catalog)) {
        const key = `${namespace}:${id}`
        const original = defaults.get(key)
        const error =
          value.locale === "en" && namespace === "tui"
            ? "Host English defaults cannot be overridden"
            : !validMessage(message)
              ? "Empty or malformed translation"
              : !original
                ? "No source message registered"
                : !compatible(message, original)
                  ? "Translation placeholders or plural selector do not match source"
                  : undefined
        if (error) {
          diagnostics.push({ plugin, locale: value.locale, key, message: error })
          continue
        }
        messages.set(key, message)
      }
    }
  }
  const rules = new Map<string, Intl.PluralRules | undefined>()
  function select(message: Message, locale: string, values?: Values): string | undefined {
    if (typeof message === "string") return message
    const count = values && Object.hasOwn(values, message.plural) ? values[message.plural] : undefined
    if (typeof count !== "number" || !Number.isFinite(count)) return
    if (!rules.has(locale))
      rules.set(locale, Intl.PluralRules.supportedLocalesOf([locale]).length ? new Intl.PluralRules(locale) : undefined)
    const rule = rules.get(locale)
    if (!rule) return
    return message.forms[rule.select(count)] ?? message.forms.other
  }
  function t(locale: string, key: string, values?: Values): string {
    const seen = new Set<string>()
    let current: string | undefined = locale
    while (current && metadata.has(current) && !seen.has(current)) {
      seen.add(current)
      const message = catalogs.get(current)?.get(key)
      const text = message === undefined ? undefined : select(message, current, values)
      if (text !== undefined) return interpolate(text, values)
      current = metadata.get(current)?.fallback
    }
    const original = defaults.get(key)
    const fallback =
      original === undefined
        ? key
        : (select(original, "en", values) ?? (typeof original === "string" ? original : original.forms.other))
    return interpolate(fallback, values)
  }
  function languages(requested?: string): readonly LanguageInfo[] {
    const result: LanguageInfo[] = [...metadata].map(([locale, info]) => ({
      locale,
      name: info.name,
      nativeName: info.nativeName,
      available: true,
      providers: [...(providers.get(locale) ?? [])],
    }))
    if (requested && !metadata.has(requested))
      result.push({ locale: requested, name: requested, nativeName: requested, available: false, providers: [] })
    return result
  }
  return { t, languages, diagnostics }
}

export function interpolate(text: string, values?: Values): string {
  return text.replace(/\{\{(\w+)\}\}/g, (token, key: string) =>
    values && Object.hasOwn(values, key) ? String(values[key]) : token,
  )
}
