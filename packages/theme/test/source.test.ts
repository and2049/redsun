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
    expect(parseTheme(source).version).toBe(2)
    expect(() => resolveThemeDocument(parseTheme(source), themeMode(source))).not.toThrow()
  }
  expect(themeMode(DEFAULT_THEMES.dusk!)).toBe("dark")
  expect(themeMode(DEFAULT_THEMES.dawn!)).toBe("light")
  expect(parseTheme({ ...DEFAULT_THEMES.dusk, version: 1 })).toEqual(parseTheme(DEFAULT_THEMES.dusk!))
})

test("shared sources accept V2, choose dark for both modes and handle invalid sources", () => {
  const source = { version: 2, dark: {}, light: {} } as const
  expect(parseTheme(source)).toEqual(source)
  expect(themeMode(source)).toBe("dark")
  expect(themeMode({ version: 2, light: {} })).toBe("light")
  for (const source of [null, [], "theme", {}, { light: {} }]) expect(isThemeSource(source)).toBe(false)
  expect(isThemeSource({ version: 3 })).toBe(true)
  expect(() => parseTheme({ version: 3 })).toThrow("Unsupported theme version: 3")
  expect(() => parseTheme({ version: 2 }, "broken")).toThrow("Invalid theme: broken")
  expect(themeMode({ version: 2 })).toBe("dark")
})

test("hex conversion preserves opaque, translucent and transparent RGBA colors", () => {
  expect(colorToHex(RGBA.fromHex("#010aff"))).toBe("#010aff")
  expect(colorToHex(RGBA.fromHex("#123456ff"))).toBe("#123456")
  expect(colorToHex(RGBA.fromHex("#12345680"))).toBe("#12345680")
  expect(colorToHex(RGBA.fromHex("#12345600"))).toBe("#12345600")
  expect(colorToHex(RGBA.fromValues(1, 0.5, 0, 0.5))).toBe("#ff800080")
})
