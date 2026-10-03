/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { v1Theme } from "../../fixture/fixture"
import { getOpenCodeTheme } from "../../fixture/opencode-v2-theme"
import { ConfigProvider } from "../../../src/config"
import { ThemeContextProvider, ThemeProvider, type ThemeError, useTheme, useThemes } from "../../../src/context/theme"

async function wait(fn: () => boolean) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > 2000) throw new Error("timed out waiting for theme mode")
    await Bun.sleep(10)
  }
}

test("takes its mode from the selected theme", async () => {
  const lightOnly = v1Theme()
  lightOnly.theme.background = "#eeeeee"
  lightOnly.theme.text = "#111111"
  const dual = v1Theme()
  dual.theme.background = { light: "#eeeeee", dark: "#111111" }
  dual.theme.text = { light: "#111111", dark: "#eeeeee" }
  const darkOnly = v1Theme()
  darkOnly.theme.background = "#111111"
  darkOnly.theme.text = "#eeeeee"
  const native = {
    base: { ...getOpenCodeTheme().base, text: { ...getOpenCodeTheme().base.text, base: "#abcdef" } },
    dark: { hue: getOpenCodeTheme().dark.hue },
  }
  let themes: ReturnType<typeof useThemes> | undefined

  function Probe() {
    const value = useThemes()
    themes = value
    return <text>{value.mode()}</text>
  }

  function current() {
    if (!themes) throw new Error("Theme provider is not mounted")
    return themes
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "light-only" } })}>
        <ThemeProvider
          source={{ discover: () => Promise.resolve({ "light-only": lightOnly, "dark-only": darkOnly, dual, native }) }}
        >
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => themes?.ready === true)
    expect(current().mode()).toBe("light")
    expect(current().set("dark-only")).toBeTrue()
    await wait(() => current().mode() === "dark")
    expect(current().set("light-only")).toBeTrue()
    await wait(() => current().mode() === "light")
    // A document carrying both modes declares no side of its own, so it reads as dark.
    expect(current().set("dual")).toBeTrue()
    await wait(() => current().mode() === "dark")
    expect(current().set("native")).toBeTrue()
    await wait(() => current().selected === "native")
    expect(current().mode()).toBe("dark")
    expect(current().current.text.base.equals(RGBA.fromHex("#abcdef"))).toBeTrue()
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  ["schema", { base: {}, light: {} }],
  ["partial mode", { base: { text: { base: "#ffffff" } }, light: {} }],
  [
    "token reference",
    {
      base: { ...getOpenCodeTheme().base, text: { ...getOpenCodeTheme().base.text, base: "$missing" } },
      light: getOpenCodeTheme().light,
    },
  ],
] as const)("falls back to the default theme when configured V2 theme %s is invalid", async (_label, source) => {
  let themes: ReturnType<typeof useThemes> | undefined
  let failure: ThemeError | undefined
  let unsubscribe: (() => void) | undefined
  const discovery = Promise.withResolvers<Record<string, unknown>>()

  function Probe() {
    const value = useThemes()
    themes = value
    unsubscribe = value.onError((error) => (failure = error))
    return <text>{value.selected}</text>
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "invalid" } })}>
        <ThemeProvider source={{ discover: () => discovery.promise }}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()
  discovery.resolve({ invalid: source })

  try {
    await wait(() => themes?.ready === true)
    expect(themes?.selected).toBe("dusk")
    expect(failure?.name).toBe("invalid")
    expect(failure?.error).toBeInstanceOf(Error)
    expect(failure?.error.message.length).toBeGreaterThan(0)
  } finally {
    unsubscribe?.()
    app.renderer.destroy()
  }
})

test("dialog surfaces are absolute and can be inherited through the theme context", async () => {
  let themes: ReturnType<typeof useThemes> | undefined
  let theme: ReturnType<typeof useTheme> | undefined
  let contextual: ReturnType<typeof useTheme> | undefined

  function ContextProbe() {
    contextual = useTheme()
    return <text>{contextual.text.base.toString()}</text>
  }

  function Probe() {
    themes = useThemes()
    theme = useTheme()
    return (
      <ThemeContextProvider context="dialog">
        <ContextProbe />
      </ThemeContextProvider>
    )
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "dusk" } })}>
        <ThemeProvider source={{ discover: async () => ({}) }}>
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => themes?.ready === true)
    if (!themes || !theme || !contextual) throw new Error("Theme provider is not mounted")
    const dialog = theme.surface("dialog")
    expect(theme.surface("dialog")).toBe(dialog)
    expect(dialog.surface("dialog")).toBe(dialog)
    expect(dialog.background.base).toBe(themes.currentTokens().background.raised.base)
    expect(contextual.background.base).toBe(dialog.background.base)
    expect(contextual.text.base).toBe(dialog.text.base)
  } finally {
    app.renderer.destroy()
  }
})

test.each(["dusk", "dawn"] as const)(
  "reactive %s theme contexts change without remounting their contents",
  async (name) => {
    const [context, setContext] = createSignal<"dialog" | undefined>("dialog")
    const [parent, setParent] = createSignal<"dialog" | undefined>()
    let theme: ReturnType<typeof useTheme> | undefined
    let themes: ReturnType<typeof useThemes> | undefined
    let mounts = 0
    function Probe() {
      mounts++
      theme = useTheme()
      themes = useThemes()
      return <text fg={theme.text.base}>probe</text>
    }
    const app = await testRender(() => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name } })}>
        <ThemeProvider source={{ discover: async () => ({}) }}>
          <ThemeContextProvider context={parent()}>
            <ThemeContextProvider context={context()}>
              <Probe />
            </ThemeContextProvider>
          </ThemeContextProvider>
        </ThemeProvider>
      </ConfigProvider>
    ))
    app.renderer.start()
    try {
      await wait(() => themes?.ready === true)
      if (!theme || !themes) throw new Error("Theme provider is not mounted")
      const view = theme
      expect(view.background.base).toBe(themes.current.surface("dialog").background.base)
      setContext(undefined)
      await app.flush()
      expect(view.background.base).toBe(themes.current.background.base)
      setParent("dialog")
      await app.flush()
      expect(view.background.base).toBe(themes.current.surface("dialog").background.base)
      setContext("dialog")
      await app.flush()
      expect(view.text.base).toBe(themes.current.surface("dialog").text.base)
      expect(theme).toBe(view)
      expect(mounts).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  },
)
