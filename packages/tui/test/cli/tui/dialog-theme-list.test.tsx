/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// Other test files register plugin themes in the module store and bun runs
// every file in one process, so the picker would list them and scroll the
// last shipped families out of the dialog's row cap. Hide them for the
// duration of a test and put them back afterwards.
async function shippedThemesOnly() {
  const { DEFAULT_THEMES, allThemes, addTheme, removeTheme } = await import("../../../src/theme")
  const extra = Object.entries(allThemes()).filter(([name]) => !(name in DEFAULT_THEMES))
  for (const [name] of extra) removeTheme(name)
  return {
    [Symbol.dispose]() {
      for (const [name, source] of extra) addTheme(name, source)
    },
  }
}

async function renderThemes(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig({ theme: { name: "dusk" } })
  const [
    { ConfigProvider },
    { ThemeProvider, useThemes },
    { Keymap },
    { DialogProvider },
    { DialogThemeList },
    { ToastProvider },
  ] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
    import("../../../src/context/keymap"),
    import("../../../src/ui/dialog"),
    import("../../../src/component/dialog-theme-list"),
    import("../../../src/ui/toast"),
  ])

  let themes!: ReturnType<typeof useThemes>
  function Themes() {
    themes = useThemes()
    onCleanup(Keymap.use().mode.push("modal"))
    return <DialogThemeList />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <Keymap.Provider>
            <ThemeProvider source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Themes />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Themes"))
  return Object.assign(app, { themes })
}

function rowOf(frame: string, text: string) {
  return frame.split("\n").findIndex((line) => line.includes(text))
}

test("lists dark/light families on one row each and tab flips the mode in place", async () => {
  await using root = await tmpdir()
  using _themes = await shippedThemesOnly()
  const app = await renderThemes(root.path)
  try {
    const dark = await app.waitForFrame((frame) => frame.includes("dusk / dawn"))
    expect(dark).toContain("Dark")
    expect(dark).toContain("Light")
    // Both siblings share a row, ordered by the dark member's name.
    expect(dark).toContain("gruvbox / parchment")
    expect(dark).toContain("nimbus / cloud")
    expect(dark).toContain("tide / wave")
    expect(rowOf(dark, "dusk / dawn")).toBeLessThan(rowOf(dark, "everforest / glade"))
    expect(rowOf(dark, "kanagawa / lotus")).toBeLessThan(rowOf(dark, "nimbus / cloud"))
    // The configured theme's family is marked current.
    expect(dark).toMatch(/●\s+dusk \/ dawn/)
    // Every row carries a preview: the background square, then three distinct
    // hue squares.
    const rows = dark.split("\n").filter((line) => line.includes("■"))
    expect(rows.length).toBeGreaterThanOrEqual(7)
    for (const row of rows) expect(row).toContain("■ ■ ■ ■")
    expect(dark).toContain("light themes")

    app.mockInput.pressTab()
    // The mode flips but the rows and the highlight stay where they are.
    const light = await app.waitForFrame((frame) => frame.includes("dark themes"))
    expect(light).toMatch(/●\s+dusk \/ dawn/)
    expect(rowOf(light, "dusk / dawn")).toBe(rowOf(dark, "dusk / dawn"))
    expect(rowOf(light, "tide / wave")).toBe(rowOf(dark, "tide / wave"))
  } finally {
    app.renderer.destroy()
  }
})

test("ctrl+b swaps the theme background for the terminal's own", async () => {
  await using root = await tmpdir()
  using _themes = await shippedThemesOnly()
  const app = await renderThemes(root.path)
  try {
    // Off by default: the theme paints its own background.
    await app.waitForFrame((frame) => frame.includes("terminal background off"))
    expect(app.themes.current.background.base.intent).toBe("rgb")

    app.mockInput.pressKey("b", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("terminal background on"))
    expect(app.themes.current.background.base.intent).toBe("default")
    // Previewing another theme keeps the setting.
    app.mockInput.pressArrow("down")
    await app.waitForFrame(() => app.themes.selected !== "dusk")
    expect(app.themes.current.background.base.intent).toBe("default")

    app.mockInput.pressKey("b", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("terminal background off"))
    expect(app.themes.current.background.base.intent).toBe("rgb")
  } finally {
    app.renderer.destroy()
  }
})

test("the system theme is one row in both modes and always shows the terminal background", async () => {
  await using root = await tmpdir()
  using _themes = await shippedThemesOnly()
  const [{ upsertTheme, removeTheme }, { systemTheme }] = await Promise.all([
    import("../../../src/theme"),
    import("../../../src/theme/system"),
  ])
  // Registered before the picker opens, as the terminal's reply is at startup.
  upsertTheme(
    "system",
    systemTheme({
      palette: [],
      defaultForeground: "#c5c8c6",
      defaultBackground: "#1d1f21",
      cursorColor: null,
      mouseForeground: null,
      mouseBackground: null,
      tekForeground: null,
      tekBackground: null,
      highlightBackground: null,
      highlightForeground: null,
    }),
  )
  const app = await renderThemes(root.path)
  try {
    const dark = await app.waitForFrame((frame) => frame.includes("system"))
    expect(dark).not.toContain("system /")
    // It leads the list rather than sorting among the named themes.
    expect(rowOf(dark, "system")).toBeLessThan(rowOf(dark, "dusk / dawn"))
    app.mockInput.pressTab()
    const light = await app.waitForFrame((frame) => frame.includes("dark themes"))
    expect(rowOf(light, "system")).toBe(rowOf(dark, "system"))

    // The setting is off, yet the system theme keeps the terminal's background.
    expect(app.themes.terminalBackground()).toBe(false)
    app.themes.select("system")
    await app.waitForFrame(() => app.themes.selected === "system")
    expect(app.themes.terminalBackground()).toBe(true)
    expect(app.themes.current.background.base.intent).toBe("default")
    expect(app.themes.current.background.base.toInts()).toEqual([0x1d, 0x1f, 0x21, 255])
  } finally {
    removeTheme("system")
    app.renderer.destroy()
  }
})

test("groups custom themes by suffix and keeps unpaired themes as a family of one", async () => {
  const [{ themeFamilies, familyMember }, { DEFAULT_THEMES }] = await Promise.all([
    import("../../../src/component/dialog-theme-list"),
    import("../../../src/theme"),
  ])
  // Real shipped documents under custom names; an unparseable source would
  // report dark regardless of its declared mode.
  const families = themeFamilies({
    dusk: DEFAULT_THEMES.dusk,
    dawn: DEFAULT_THEMES.dawn,
    "solar-light": DEFAULT_THEMES.dawn,
    "solar-dark": DEFAULT_THEMES.dusk,
    mono: DEFAULT_THEMES.dusk,
  })
  expect(families).toEqual([
    { key: "dusk", dark: "dusk", light: "dawn" },
    { key: "mono", dark: "mono" },
    { key: "solar", dark: "solar-dark", light: "solar-light" },
  ])
  expect(familyMember(families[0]!, "light")).toBe("dawn")
  // A family of one shows its only member whatever the mode.
  expect(familyMember(families[1]!, "light")).toBe("mono")
})
