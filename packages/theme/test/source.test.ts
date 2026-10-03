import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  DEFAULT_THEMES,
  colorToHex,
  isThemeSource,
  parseTheme,
  resolveThemeDocument,
  themeMode,
} from "../src/tui/index.js"

test("shared sources parse shipped V1 themes and select their declared mode", () => {
  for (const [name, source] of Object.entries(DEFAULT_THEMES)) {
    expect(isThemeSource(source)).toBe(true)
    expect(parseTheme(source).base).toBeDefined()
    expect(() => resolveThemeDocument(parseTheme(source, name), themeMode(source))).not.toThrow()
  }
  expect(themeMode(DEFAULT_THEMES.dusk!)).toBe("dark")
  expect(themeMode(DEFAULT_THEMES.dawn!)).toBe("light")
})

test("shared sources accept V2, choose dark for both modes and handle invalid sources", () => {
  const document = parseTheme(DEFAULT_THEMES.dusk!)
  const both = { base: document.base, light: document.dark, dark: document.dark }
  expect(parseTheme(both) as unknown).toEqual(both)
  expect(themeMode(both)).toBe("dark")
  expect(themeMode({ base: document.base, light: document.dark })).toBe("light")
  for (const source of [null, [], "theme", {}, { light: {} }, { version: 2 }]) expect(isThemeSource(source)).toBe(false)
  expect(() => parseTheme({ base: {} }, "broken")).toThrow("Invalid theme: broken")
  expect(themeMode({ base: {} })).toBe("dark")
})

test("hex conversion preserves opaque, translucent and transparent RGBA colors", () => {
  expect(colorToHex(RGBA.fromHex("#010aff"))).toBe("#010aff")
  expect(colorToHex(RGBA.fromHex("#123456ff"))).toBe("#123456")
  expect(colorToHex(RGBA.fromHex("#12345680"))).toBe("#12345680")
  expect(colorToHex(RGBA.fromHex("#12345600"))).toBe("#12345600")
  expect(colorToHex(RGBA.fromValues(1, 0.5, 0, 0.5))).toBe("#ff800080")
})
