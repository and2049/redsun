import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider, resolve } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

test.each([
  ["zh-CN", "搜索", "未找到结果"],
  ["fr", "Rechercher", "Aucun résultat trouvé"],
] as const)(
  "picker chrome translates in %s while caller-provided content stays verbatim",
  async (language, search, empty) => {
    let selected: string | undefined
    function Fixture() {
      const dialog = useDialog()
      onMount(() =>
        dialog.replace(() => (
          <DialogSelect
            title="Settings"
            options={[{ title: "Model", category: "Session", value: "original-id" }]}
            onSelect={(option) => {
              selected = option.value
            }}
          />
        )),
      )
      return null
    }
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={resolve({ language }, { terminalSuspend: true })}>
            <Keymap.Provider>
              <ThemeProvider source={emptyThemeSource}>
                <ToastProvider>
                  <DialogProvider>
                    <Fixture />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 44, height: 30, kittyKeyboard: true },
    )
    app.renderer.start()
    try {
      const frame = await app.waitForFrame((frame) => frame.includes(search) && frame.includes("Model"))
      expect(frame).toContain("Settings")
      expect(frame).toContain("Session")
      await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
      const input = app.renderer.currentFocusedEditor
      if (!(input instanceof InputRenderable)) throw new Error("Missing search field")
      input.value = "not-a-model"
      await app.waitForFrame((frame) => frame.includes(empty))
      input.value = "Model"
      await app.waitForFrame((frame) => frame.includes("Model") && !frame.includes(empty))
      app.mockInput.pressEnter()
      await app.waitFor(() => selected === "original-id")
    } finally {
      app.renderer.destroy()
    }
  },
)
