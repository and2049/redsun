import {
  DEFAULT_THEMES,
  isThemeSource,
  parseTheme as parseThemeSource,
  type ThemeDocument,
  type ThemeDocumentSource,
} from "@opencode-ai/theme/tui"

export { generateSyntax, selectedForeground, type Theme, type ThemeV1Json } from "./v1"
export {
  DEFAULT_THEMES,
  isThemeSource,
  themeMode,
  resolveThemeDocument,
  type ThemeDocument,
  type ThemeDocumentSource,
} from "@opencode-ai/theme/tui"

const pluginThemes: Record<string, ThemeDocumentSource> = {}
let customThemes: Record<string, ThemeDocumentSource> = {}
const listeners = new Set<(themes: Record<string, ThemeDocumentSource>) => void>()
const parsed = new WeakMap<object, ThemeDocument>()

function listThemes(): Record<string, ThemeDocumentSource> {
  return { ...DEFAULT_THEMES, ...pluginThemes, ...customThemes }
}

function syncThemes() {
  const themes = listThemes()
  for (const listener of listeners) listener(themes)
}

export function allThemes() {
  return listThemes()
}

export function parseTheme(source: ThemeDocumentSource, name = "theme") {
  const cached = parsed.get(source)
  if (cached) return cached
  const document = parseThemeSource(source, name)
  parsed.set(source, document)
  return document
}

export function subscribeThemes(listener: (themes: Record<string, ThemeDocumentSource>) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setCustomThemes(themes: Record<string, unknown>) {
  customThemes = Object.fromEntries(
    Object.entries(themes).filter((entry): entry is [string, ThemeDocumentSource] => isThemeSource(entry[1])),
  )
  syncThemes()
}

export function hasTheme(name: string) {
  if (!name) return false
  return allThemes()[name] !== undefined
}

export function addTheme(name: string, theme: unknown) {
  if (!name) return false
  if (!isThemeSource(theme)) return false
  if (hasTheme(name)) return false
  pluginThemes[name] = theme
  syncThemes()
  return true
}

export function upsertTheme(name: string, theme: unknown) {
  if (!name) return false
  if (!isThemeSource(theme)) return false
  if (customThemes[name] !== undefined) customThemes[name] = theme
  else pluginThemes[name] = theme
  syncThemes()
  return true
}

export { resolveV1 as resolveTheme } from "@opencode-ai/theme/tui/v1"
