import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

for (const action of ["escape", "skip", "update"] as const) {
  test(`update dialog only dismisses the notice on skip: ${action}`, async () => {
    await using temporary = await tmpdir()
    const calls: string[] = []

    function OpenDialog() {
      const current = useDialog()
      onMount(() =>
        current.replace(() => (
          <DialogUpdate
            state={() => ({ type: "available", version: "1.2.3" })}
            skip={() => void calls.push("skip")}
            install={async () => void calls.push("update")}
            restart={() => void calls.push("restart")}
          />
        )),
      )
      return null
    }

    const app = await testRender(
      () => (
        <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ThemeProvider source={emptyThemeSource}>
                <ToastProvider>
                  <DialogProvider>
                    <OpenDialog />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 100, height: 24, kittyKeyboard: true },
    )

    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Update available"))
      expect(calls).toEqual([])
      if (action === "escape") app.mockInput.pressEscape()
      else {
        if (action === "skip") app.mockInput.pressArrow("left")
        app.mockInput.pressEnter()
      }
      if (action === "update") await app.waitFor(() => calls.length === 1)
      else await app.waitForFrame((frame) => !frame.includes("Update available"))
      expect(calls).toEqual(action === "escape" ? [] : [action])
    } finally {
      app.renderer.destroy()
    }
  })
}
