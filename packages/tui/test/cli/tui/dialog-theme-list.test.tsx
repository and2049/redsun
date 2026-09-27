/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function renderThemes(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig({ theme: { name: "dusk" } })
  const [{ ConfigProvider }, { ThemeProvider }, { Keymap }, { DialogProvider }, { DialogThemeList }, { ToastProvider }] =
    await Promise.all([
      import("../../../src/config"),
      import("../../../src/context/theme"),
      import("../../../src/context/keymap"),
      import("../../../src/ui/dialog"),
      import("../../../src/component/dialog-theme-list"),
      import("../../../src/ui/toast"),
    ])

  function Themes() {
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
  return app
}

function rowOf(frame: string, text: string) {
  return frame.split("\n").findIndex((line) => line.includes(text))
}

test("lists dark/light families on one row each and tab flips the mode in place", async () => {
  await using root = await tmpdir()
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
