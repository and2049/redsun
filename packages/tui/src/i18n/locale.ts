export type Locale = string

export function canonicalLocale(value: string): string {
  const locale = Intl.getCanonicalLocales(value)[0]
  if (!locale) throw new Error("Language locale is required")
  return locale
}

export function isLocale(value: string): boolean {
  try {
    canonicalLocale(value)
    return true
  } catch {
    return false
  }
}
