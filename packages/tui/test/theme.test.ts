import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_THEMES, addTheme, allThemes, hasTheme, resolveTheme, themeMode } from "../src/theme"
import { discoverThemes } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.dusk)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.dusk)
  const two = structuredClone(DEFAULT_THEMES.dusk)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.dusk)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.dusk)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item)).toThrow("Circular color reference")
})

test("themeMode uses declared mode and falls back to background luminance", () => {
  expect(themeMode(DEFAULT_THEMES.dusk)).toBe("dark")
  expect(themeMode(DEFAULT_THEMES.dawn)).toBe("light")

  const undeclaredDark = structuredClone(DEFAULT_THEMES.dusk)
  delete undeclaredDark.mode
  expect(themeMode(undeclaredDark)).toBe("dark")

  const undeclaredLight = structuredClone(DEFAULT_THEMES.dawn)
  delete undeclaredLight.mode
  expect(themeMode(undeclaredLight)).toBe("light")
})

test("resolveTheme resolves legacy variant values against the theme's own mode", () => {
  const item = structuredClone(DEFAULT_THEMES.dawn)
  item.theme.primary = { dark: "#101010", light: "#fefefe" }
  const resolved = resolveTheme(item)
  expect(resolved.primary.r).toBeCloseTo(254 / 255)
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
