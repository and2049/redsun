import { Schema } from "effect"
import {
  migrateV1,
  resolveThemeDocument,
  ThemeDocument,
  themeDecodeError,
  themeModes,
} from "@opencode-ai/theme/tui"
import { resolveThemeColors } from "./resolve"
import { type Theme, type ThemeV1Json } from "./v1"
import cloud from "./assets/cloud.json" with { type: "json" }
import dawn from "./assets/dawn.json" with { type: "json" }
import dusk from "./assets/dusk.json" with { type: "json" }
import everforest from "./assets/everforest.json" with { type: "json" }
import glade from "./assets/glade.json" with { type: "json" }
import gruvbox from "./assets/gruvbox.json" with { type: "json" }
import kanagawa from "./assets/kanagawa.json" with { type: "json" }
import lotus from "./assets/lotus.json" with { type: "json" }
import parchment from "./assets/parchment.json" with { type: "json" }
import petal from "./assets/petal.json" with { type: "json" }
import rosepine from "./assets/rosepine.json" with { type: "json" }
import wave from "./assets/wave.json" with { type: "json" }

export { generateSyntax, selectedForeground, type Theme, type ThemeV1Json } from "./v1"
export { resolveThemeDocument, type ThemeDocument }

export type ThemeDocumentSource = Record<string, unknown>

export const DEFAULT_THEMES: Record<string, ThemeDocumentSource> = {
  cloud,
  dawn,
  dusk,
  everforest,
  glade,
  gruvbox,
  kanagawa,
  lotus,
  parchment,
  petal,
  rosepine,
  wave,
}

const pluginThemes: Record<string, ThemeDocumentSource> = {}
let customThemes: Record<string, ThemeDocumentSource> = {}
const listeners = new Set<(themes: Record<string, ThemeDocumentSource>) => void>()
const parsed = new WeakMap<object, ThemeDocument>()
const decodeThemeDocument = Schema.decodeUnknownSync(ThemeDocument, { reportInput: true })

function listThemes(): Record<string, ThemeDocumentSource> {
  // Priority: defaults < plugin installs < custom files.
  return {
    ...DEFAULT_THEMES,
    ...pluginThemes,
    ...customThemes,
  }
}

function syncThemes() {
  const themes = listThemes()
  for (const listener of listeners) listener(themes)
}

export function allThemes() {
  return listThemes()
}

export function isThemeSource(source: unknown): source is ThemeDocumentSource {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false
  return "theme" in source || "version" in source
}

export function parseTheme(source: ThemeDocumentSource, name = "theme") {
  const cached = parsed.get(source)
  if (cached) return cached

  const version = source.version ?? 1
  const document =
    version === 1
      ? migrateV1(source as ThemeV1Json)
      : version === 2
        ? decodeV2Theme(source, name)
        : unsupportedThemeVersion(version)

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

// A theme belongs to one half of the picker. A document that provides both
// modes declares no side of its own, so it reads as dark -- the side the
// fallback theme sits on.
export function themeMode(source: ThemeDocumentSource, name?: string): "dark" | "light" {
  try {
    const modes = themeModes(parseTheme(source, name))
    return modes.length === 1 ? modes[0]! : "dark"
  } catch {
    // Listing a theme must not depend on it parsing -- a broken plugin or user
    // document still belongs somewhere, and selecting it is what surfaces the
    // error.
    return "dark"
  }
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
  if (customThemes[name] !== undefined) {
    customThemes[name] = theme
  } else {
    pluginThemes[name] = theme
  }
  syncThemes()
  return true
}

export function resolveTheme(theme: ThemeV1Json, mode: "dark" | "light"): Theme {
  const resolved = resolveThemeColors(theme, mode)
  return {
    ...resolved.theme,
    _hasSelectedListItemText: resolved.hasSelectedListItemText,
    thinkingOpacity: resolved.thinkingOpacity,
  }
}

function decodeV2Theme(source: ThemeDocumentSource, name: string) {
  try {
    return decodeThemeDocument(source)
  } catch (error) {
    throw themeDecodeError(error, name)
  }
}

function unsupportedThemeVersion(version: unknown): never {
  throw new Error(`Unsupported theme version: ${String(version)}`)
}
