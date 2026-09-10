import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { ConfigProvider, resolve } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { translate } from "../fixture/languages"
import { Dialog } from "../../src/ui/dialog"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

for (const placement of ["default", "bottom"] as const) {
  test.each(["en", "zh-CN", "ko", "es", "fr"] as const)(
    `${placement} dialog backdrop preserves %s footer text while open`,
    async (language) => {
      const [open, setOpen] = createSignal(false)
      const approval = translate(language, "Auto-approve all enabled ")
      const cache = translate(language, "cache {{percent}}%", { percent: 90 })
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <ConfigProvider config={resolve({}, { terminalSuspend: true })}>
              <ThemeProvider source={emptyThemeSource}>
                <box width="100%" height="100%" backgroundColor="#202020">
                  <box position="absolute" bottom={placement === "bottom" ? 4 : 0}>
                    <text fg="#ffffff">{approval}(Shift+Tab)</text>
                    <text fg="#ffffff">{cache}</text>
                  </box>
                  <Show when={open()}>
                    <Dialog placement={placement} onClose={() => setOpen(false)}>
                      <text fg="#ffffff">Menu</text>
                    </Dialog>
                  </Show>
                </box>
              </ThemeProvider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        { width: 100, height: 24 },
      )
      app.renderer.start()
      const span = (text: string) => {
        const found = app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes(text))
        if (!found) throw new Error(`Missing rendered span: ${text}`)
        return found
      }
      try {
        await app.waitForFrame((frame) => frame.includes(approval) && frame.includes(cache))
        const before = span(cache)
        setOpen(true)
        const frame = await app.waitForFrame((frame) => frame.includes("Menu"))
        expect(frame).toContain(approval)
        expect(frame).toContain(cache)
        expect(frame).toContain("(Shift+Tab)")
        const behind = span(cache)
        expect(span(approval).fg.toInts()).toEqual(behind.fg.toInts())
        expect(span("Menu").fg.toInts()).toEqual([255, 255, 255, 255])
        if (placement === "default") {
          expect(behind.fg.toInts()).toEqual([105, 105, 105, 255])
          expect(behind.bg.toInts()).toEqual([13, 13, 13, 255])
        } else {
          expect(behind.fg.toInts()).toEqual(before.fg.toInts())
          expect(behind.bg.toInts()).toEqual(before.bg.toInts())
        }
        await app.renderOnce()
        expect(span(cache).fg.toInts()).toEqual(behind.fg.toInts())
        await app.mockMouse.click(0, 0)
        await app.waitForFrame((frame) => !frame.includes("Menu") && frame.includes(approval) && frame.includes(cache))
        expect(span(cache).fg.toInts()).toEqual(before.fg.toInts())
        expect(span(cache).bg.toInts()).toEqual(before.bg.toInts())
      } finally {
        app.renderer.destroy()
      }
    },
  )
}
