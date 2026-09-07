import { Schema } from "effect"
import { migrateV1 } from "./v1-migrate.js"
import type { ThemeV1Json } from "./v1.js"
import { ThemeDocument } from "./schema.js"
import { themeDecodeError } from "./resolve.js"
import { themeModes } from "./select.js"
import cloud from "./assets/cloud.json" with { type: "json" }
import dawn from "./assets/dawn.json" with { type: "json" }
import dusk from "./assets/dusk.json" with { type: "json" }
import everforest from "./assets/everforest.json" with { type: "json" }
import glade from "./assets/glade.json" with { type: "json" }
import gruvbox from "./assets/gruvbox.json" with { type: "json" }
import kanagawa from "./assets/kanagawa.json" with { type: "json" }
import lotus from "./assets/lotus.json" with { type: "json" }
import nimbus from "./assets/nimbus.json" with { type: "json" }
import parchment from "./assets/parchment.json" with { type: "json" }
import petal from "./assets/petal.json" with { type: "json" }
import rosepine from "./assets/rosepine.json" with { type: "json" }
import tide from "./assets/tide.json" with { type: "json" }
import wave from "./assets/wave.json" with { type: "json" }

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
  nimbus,
  parchment,
  petal,
  rosepine,
  tide,
  wave,
}

const decodeThemeDocument = Schema.decodeUnknownSync(ThemeDocument, { reportInput: true })

export function isThemeSource(source: unknown): source is ThemeDocumentSource {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false
  return "theme" in source || "version" in source
}

export function parseTheme(source: ThemeDocumentSource, name = "theme") {
  const version = source.version ?? 1
  if (version === 1) return migrateV1(source as ThemeV1Json)
  if (version !== 2) throw new Error(`Unsupported theme version: ${String(version)}`)
  try {
    return decodeThemeDocument(source)
  } catch (error) {
    throw themeDecodeError(error, name)
  }
}

export function themeMode(source: ThemeDocumentSource, name?: string): "dark" | "light" {
  try {
    const modes = themeModes(parseTheme(source, name))
    return modes.length === 1 ? modes[0]! : "dark"
  } catch {
    return "dark"
  }
}
