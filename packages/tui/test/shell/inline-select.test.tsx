/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import type { DialogSelectOption, DialogSelectProps } from "../../src/ui/dialog-select"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const OPTIONS: DialogSelectOption<string>[] = [
  { title: "claude-opus-5", value: "opus", category: "Anthropic" },
  { title: "claude-sonnet-5", value: "sonnet", category: "Anthropic" },
  { title: "gpt-5", value: "gpt", category: "OpenAI" },
]

async function mount(input: {
  options?: DialogSelectOption<string>[]
  current?: string
  onSelect?: (option: DialogSelectOption<string>) => void
  actions?: DialogSelectProps<string>["actions"]
  ui?: "dense" | "classic"
}) {
  const [
    { DialogSelect },
    { DialogProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../src/ui/dialog-select"),
    import("../../src/ui/dialog"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ ui: input.ui })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <DialogSelect
                      title="Switch model"
                      options={input.options ?? OPTIONS}
                      current={input.current}
                      onSelect={input.onSelect}
                      actions={input.actions}
                    />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  return app
}

// The first mount in a file pays for async theme/KV setup, so retry until the
// frame has content (and, when given, until it satisfies `until`).
async function settle(app: Awaited<ReturnType<typeof testRender>>, until?: (frame: string) => boolean) {
  let frame = ""
  for (let attempt = 0; attempt < 10; attempt++) {
    await app.renderOnce()
    await Bun.sleep(25)
    frame = app.captureCharFrame()
    if (frame.trim().length > 0 && (!until || until(frame))) return frame
  }
  return frame
}

test("dense mode renders selects inline, without the modal panel chrome", async () => {
  const app = await mount({ current: "sonnet" })
  try {
    const frame = await settle(app, (value) => value.includes("Switch model"))
    expect(frame).toContain("Switch model")
    expect(frame).toContain("claude-opus-5")
    expect(frame).toContain("gpt-5")
    // Position counter replaces the modal's scrollbox.
    expect(frame).toContain("2/3")
    // Categories collapse into a trailing suffix instead of a header row.
    expect(frame).toContain("Anthropic")
    expect(frame).toContain("OpenAI")
  } finally {
    app.renderer.destroy()
  }
})

test("the inline select reports the rows the dock should reserve", async () => {
  const { inlineSelectRows } = await import("../../src/shell/dock/inline-select")
  const app = await mount({})
  try {
    await settle(app, () => inlineSelectRows() > 0)
    // title + filter + three option rows, no footer actions.
    expect(inlineSelectRows()).toBe(5)
  } finally {
    app.renderer.destroy()
  }
  await wait(() => inlineSelectRows() === 0)
})

test("a long list windows to the maximum dock rows", async () => {
  const { inlineSelectRows, INLINE_SELECT_MAX_ROWS } = await import("../../src/shell/dock/inline-select")
  const options = Array.from({ length: 40 }, (_, index) => ({
    title: `option-${index}`,
    value: `v-${index}`,
  }))
  const app = await mount({ options })
  try {
    const frame = await settle(app, () => inlineSelectRows() > 0)
    expect(inlineSelectRows()).toBe(2 + INLINE_SELECT_MAX_ROWS)
    expect(frame).toContain("option-0")
    expect(frame).not.toContain("option-39")
    expect(frame).toContain("1/40")
  } finally {
    app.renderer.destroy()
  }
})

test("filtering narrows the list and submits the top match", async () => {
  const selected: string[] = []
  const app = await mount({ onSelect: (option) => selected.push(option.value) })
  try {
    await settle(app)
    await app.mockInput.typeText("gpt")
    const frame = await settle(app)
    expect(frame).toContain("gpt-5")
    expect(frame).not.toContain("claude-opus-5")
    expect(frame).toContain("1/1")

    app.mockInput.pressEnter()
    expect(selected).toEqual(["gpt"])
  } finally {
    app.renderer.destroy()
  }
})

test("arrow navigation moves the selection and enter submits it", async () => {
  const selected: string[] = []
  const app = await mount({ onSelect: (option) => selected.push(option.value) })
  try {
    await settle(app)
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    expect(await settle(app)).toContain("3/3")

    app.mockInput.pressEnter()
    expect(selected).toEqual(["gpt"])
  } finally {
    app.renderer.destroy()
  }
})

test("classic mode still renders the modal picker", async () => {
  const app = await mount({ ui: "classic" })
  try {
    const frame = await settle(app)
    expect(frame).toContain("Switch model")
    // The modal has no inline position counter.
    expect(frame).not.toContain("1/3")
  } finally {
    app.renderer.destroy()
  }
})
