/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const SELECTED = 2
const UNSELECTED = 15

// The transcript's markdown takes the base background as `bg`, and a selection swaps a
// cell's colours.
async function selectedCells(theme: { name: string; terminal_background?: boolean }) {
  await using root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig({ theme })
  const [{ ConfigProvider }, { ThemeProvider, useTheme, useThemes }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
  ])
  function Doc() {
    const theme = useTheme()
    const themes = useThemes()
    return (
      <markdown
        content="Plain paragraph here."
        syntaxStyle={themes.currentSyntax()}
        streaming={false}
        internalBlockMode="top-level"
        conceal
        fg={theme.markdown.text}
        bg={theme.background.base}
      />
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={root.path} paths={{ home: root.path, state, worktree: root.path }}>
        <ConfigProvider config={config}>
          <ThemeProvider source={emptyThemeSource}>
            <Doc />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 4, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Plain paragraph"))
    await app.mockMouse.drag(0, 0, 8, 0)
    await app.renderOnce()
    const { fg, bg } = app.renderer.currentRenderBuffer.buffers
    const cell = (colors: Uint16Array, column: number) => ({
      rgb: [...colors.subarray(column * 4, column * 4 + 3)].map((channel) => channel & 255),
      default: colors[column * 4 + 1]! >>> 8 !== 0,
    })
    return {
      selected: { fg: cell(fg, SELECTED), bg: cell(bg, SELECTED) },
      unselected: { fg: cell(fg, UNSELECTED), bg: cell(bg, UNSELECTED) },
    }
  } finally {
    app.renderer.destroy()
  }
}

test("a selection looks the same with the terminal background on", async () => {
  const off = await selectedCells({ name: "dusk" })
  const on = await selectedCells({ name: "dusk", terminal_background: true })
  // Selected text is the theme's background colour itself, never the terminal's default text colour.
  expect(off.selected.fg.rgb).toEqual(off.unselected.bg.rgb)
  expect(on.selected).toEqual(off.selected)
  // Only the unselected background differs: it stays the terminal's own.
  expect(on.unselected.fg).toEqual(off.unselected.fg)
  expect(on.unselected.bg).toEqual({ ...off.unselected.bg, default: true })
})

test("a selection stays readable under the system theme", async () => {
  const [{ upsertTheme, removeTheme }, { systemTheme }] = await Promise.all([
    import("../src/theme"),
    import("../src/theme/system"),
  ])
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
  try {
    const cells = await selectedCells({ name: "system" })
    expect(cells.unselected.bg).toEqual({ rgb: [0x1d, 0x1f, 0x21], default: true })
    expect(cells.selected.fg).toEqual({ rgb: [0x1d, 0x1f, 0x21], default: false })
    expect(cells.selected.bg).toEqual(cells.unselected.fg)
  } finally {
    removeTheme("system")
  }
})
