import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { RGBA, type TerminalColors } from "@opentui/core"
import {
  addTheme,
  allThemes,
  hasTheme,
  parseTheme,
  resolveTheme,
  setCustomThemes,
  upsertTheme,
} from "../src/theme"
import { discoverThemes } from "../src/theme/discovery"
import { configDirectories } from "../src/util/config-directories"
import { terminalMode } from "../src/theme/system"
import { tmpdir, v1Theme } from "./fixture/fixture"
import { resolveThemeDocument } from "@opencode-ai/theme/tui"
import { DEFAULT_THEMES } from "../src/theme"

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  const theme = v1Theme()
  expect(addTheme(name, theme)).toBe(true)
  expect(allThemes()[name]).toBe(theme)
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = v1Theme()
  const two = v1Theme()
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]).toBe(one)
})

test("addTheme ignores values without a V1 theme or version", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(addTheme(name, { light: {} })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("addTheme defers validation of versioned sources", () => {
  const name = `plugin-theme-versioned-${Date.now()}`
  expect(addTheme(name, { version: 2 })).toBe(true)
  expect(() => parseTheme(allThemes()[name]!, name)).toThrow(`Invalid theme: ${name}`)
})

test("parseTheme delegates malformed V1 sources and rejects unknown versions", () => {
  expect(() => parseTheme({})).toThrow()
  expect(() => parseTheme({ version: 3 })).toThrow("Unsupported theme version: 3")
})

test("parses unversioned and explicit V1 themes lazily once", () => {
  const unversioned = v1Theme()
  const explicit = { ...v1Theme(), version: 1 }
  const first = parseTheme(unversioned, "unversioned")
  const second = parseTheme(explicit, "explicit")

  expect(first.version).toBe(2)
  expect(second.version).toBe(2)
  expect(parseTheme(unversioned, "unversioned")).toBe(first)
  expect(parseTheme(explicit, "explicit")).toBe(second)
})

test("decodes native V2 themes lazily once", () => {
  const name = `plugin-theme-v2-${Date.now()}`
  const source = { version: 2, light: { categorical: ["red"] } } as const

  expect(addTheme(name, source)).toBe(true)
  expect(allThemes()[name]).toBe(source)
  const document = parseTheme(allThemes()[name]!, name)
  expect(document.light?.categorical).toEqual(["red"])
  expect(parseTheme(allThemes()[name]!, name)).toBe(document)
})

test("defers invalid V2 errors until parsing", () => {
  const name = `plugin-theme-invalid-v2-${Date.now()}`
  expect(addTheme(name, { version: 2, light: { categorical: [] } })).toBe(true)
  expect(() => parseTheme(allThemes()[name]!, name)).toThrow(`Invalid theme: ${name}`)
})

test("defers invalid V1 errors until parsing", () => {
  const name = `plugin-theme-invalid-v1-${Date.now()}`
  const source = v1Theme()
  source.defs = { ...source.defs, one: "two", two: "one" }
  source.theme.primary = "one"

  expect(addTheme(name, source)).toBe(true)
  expect(() => parseTheme(allThemes()[name]!, name)).toThrow("Circular color reference")
})

test("replacement sources receive independent parse caches", () => {
  const name = `plugin-theme-replace-${Date.now()}`
  const first = v1Theme()
  const second = v1Theme()
  second.theme.primary = "#123456"

  expect(addTheme(name, first)).toBe(true)
  const previous = parseTheme(allThemes()[name]!, name)
  expect(upsertTheme(name, second)).toBe(true)
  const next = parseTheme(allThemes()[name]!, name)
  expect(next).not.toBe(previous)
  expect(parseTheme(allThemes()[name]!, name)).toBe(next)
})

test("custom themes retain precedence over plugin themes", () => {
  const name = `plugin-theme-precedence-${Date.now()}`
  const plugin = v1Theme()
  const custom = v1Theme()

  expect(addTheme(name, plugin)).toBe(true)
  setCustomThemes({ [name]: custom })
  expect(allThemes()[name]).toBe(custom)
  setCustomThemes({})
  expect(allThemes()[name]).toBe(plugin)
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, v1Theme())).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme rejects circular color refs", () => {
  const item = v1Theme()
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

test("resolveTheme preserves full theme numeric color and marker semantics", () => {
  const item = v1Theme()
  item.theme.primary = 6
  delete item.theme.selectedListItemText

  const theme = resolveTheme(item, "dark")
  expect(theme.primary.intent).toBe("rgb")
  expect(theme.selectedListItemText).toBe(theme.background)
  expect(theme._hasSelectedListItemText).toBe(false)
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
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

test("theme directories include global config before project directories", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "repo", "package")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, ".redsun", "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "global.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, ".redsun", "themes", "project.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes(configDirectories(global, project))).resolves.toEqual({
    global: { source: "global" },
    project: { source: "project" },
  })
})

test("ships the fourteen redsun themes, each resolving in the mode it declares", () => {
  // v0.3.0 split dark/light pairs into standalone single-mode themes rather
  // than pairing modes inside one document, and the picker is built around
  // that. Each is a flat v1 document run through migrateV1, so this also
  // catches a malformed one.
  expect(Object.keys(DEFAULT_THEMES).toSorted()).toEqual([
    "cloud",
    "dawn",
    "dusk",
    "everforest",
    "glade",
    "gruvbox",
    "kanagawa",
    "lotus",
    "nimbus",
    "parchment",
    "petal",
    "rosepine",
    "tide",
    "wave",
  ])

  for (const [name, source] of Object.entries(DEFAULT_THEMES)) {
    const document = parseTheme(source, name)
    expect(document.version, name).toBe(2)
    expect(document.standalone, name).toBe(true)
    const modes = [document.light ? "light" : undefined, document.dark ? "dark" : undefined].filter(Boolean)
    expect(modes.length, name).toBe(1)
    const resolved = resolveThemeDocument(document, modes[0] as "light" | "dark")
    expect(resolved.text.default, name).toBeDefined()
    // Every theme names its own wordmark gradient; without it the home screen
    // falls back to the generic default and the theme reads as unfinished.
    expect(resolved.logo.gradient.start, name).toBeDefined()
    expect(resolved.logo.gradient.end, name).toBeDefined()
    // Every theme names the three primary agent modes so their colours are
    // customizable individually instead of assigned positionally.
    expect(Object.keys(resolved.agents).toSorted(), name).toEqual(["build", "compose", "plan"])
  }
})

test("shipped themes resolve only to colours they declare", () => {
  // The TUI must never paint a shade a theme file did not name. Migration snaps
  // every hue step to a declared anchor rather than interpolating between them,
  // so this covers the whole hue block and every semantic slot in the base,
  // elevated and overlay views. It is an invariant of the shipped fourteen, not
  // of the format: `selectedForeground` still falls back to pure black or white
  // for a theme that declares a transparent background and no
  // `selectedListItemText`, and none of these do.
  const hex = (color: RGBA) => {
    const [r, g, b, a] = color.toInts()
    const byte = (value: number) => value.toString(16).padStart(2, "0")
    return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
  }

  function* colors(value: unknown, path = ""): Generator<[string, RGBA]> {
    if (value instanceof RGBA) {
      yield [path, value]
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, entry] of Object.entries(value)) {
      yield* colors(entry, path ? `${path}.${key}` : key)
    }
  }

  for (const [name, source] of Object.entries(DEFAULT_THEMES)) {
    const document = parseTheme(source, name)
    const mode = document.light ? "light" : "dark"
    // resolveTheme answers with exactly the colours the file names, having
    // already walked `defs`, mode forks and ANSI codes.
    const declared = new Set([...colors(resolveTheme(source as never, mode))].map(([, color]) => hex(color)))
    expect(declared.size, name).toBeGreaterThan(0)

    for (const [path, color] of colors(resolveThemeDocument(document, mode))) {
      // A token may opt out of painting entirely.
      if (color.toInts()[3] === 0) continue
      expect(declared, `${name}.${path}`).toContain(hex(color))
    }
  }
})
