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

test("lists dark themes first and swaps to the light tab", async () => {
  await using root = await tmpdir()
  const app = await renderThemes(root.path)
  try {
    const dark = await app.waitForFrame((frame) => frame.includes("dusk"))
    expect(dark).toContain("Dark")
    expect(dark).toContain("Light")
    expect(dark).toContain("gruvbox")
    expect(dark).not.toContain("parchment")

    app.mockInput.pressTab()
    // gruvbox <-> parchment are built-in siblings, so the tab keeps the pair.
    const light = await app.waitForFrame((frame) => frame.includes("wave"))
    expect(light).toContain("dawn")
    // `wave` declares itself light even though it paints light text on mid-blue.
    expect(light).toContain("wave")
    expect(light).not.toContain("gruvbox")
  } finally {
    app.renderer.destroy()
  }
})
