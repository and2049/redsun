import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { onMount } from "solid-js"
import { DialogConfig } from "../../src/component/dialog-config"
import { ConfigProvider, Info, resolve } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { LocationProvider } from "../../src/context/location"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { useLanguage } from "../../src/i18n"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { createApi, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { TestLanguages } from "../fixture/languages"

test("language picker saves, switches live, supports English search, and recovers from save failure", async () => {
  let stored: Info = { theme: { name: "dusk" }, mouse: false }
  let fail = false
  let writes = 0
  let delay: Promise<void> | undefined
  let pending = false
  const api = createApi(createFetch((url) => (url.pathname === "/api/config/context" ? json({}) : undefined)).fetch)

  function Fixture() {
    const dialog = useDialog()
    const { t } = useLanguage()
    onMount(() => dialog.replace(() => <DialogConfig current="language" />))
    return (
      <>
        <text>{t("tui:settings.language.title")}</text>
        <Toast />
      </>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClientProvider api={api}>
          <DataProvider directory="/project">
            <LocationProvider>
              <ConfigProvider
                config={resolve(stored, { terminalSuspend: true })}
                service={{
                  get: async () => stored,
                  update: async (update) => {
                    if (fail) throw new Error("Language save failed")
                    if (delay) {
                      pending = true
                      await delay
                    }
                    const draft = structuredClone(stored)
                    update(draft)
                    stored = Schema.decodeUnknownSync(Info)(draft)
                    writes++
                    return stored
                  },
                }}
              >
                <TestLanguages>
                  <Keymap.Provider>
                    <ThemeProvider source={emptyThemeSource}>
                      <ToastProvider>
                        <DialogProvider>
                          <Fixture />
                        </DialogProvider>
                      </ToastProvider>
                    </ThemeProvider>
                  </Keymap.Provider>
                </TestLanguages>
              </ConfigProvider>
            </LocationProvider>
          </DataProvider>
        </ClientProvider>
      </TestTuiContexts>
    ),
    { width: 90, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()

  async function search(value: string) {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof InputRenderable)) throw new Error("Missing search field")
    input.value = value
    await app.renderOnce()
  }

  try {
    await app.waitForFrame((frame) => frame.includes("Interface language") && frame.includes("English"))
    await search("Interface language")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Español") && frame.includes("한국어"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Settings") && !frame.includes("/ Language"))
    expect(writes).toBe(0)
    await search("Interface language")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("/ Language"))
    await search("Spanish")
    fail = true
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Language save failed"))
    expect(stored.language).toBeUndefined()
    fail = false
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Idioma de la interfaz") && !frame.includes("/ Language"))
    expect(stored.language).toBe("es")

    for (const [searchTerm, language, label] of [
      ["한국어", "ko", "인터페이스 언어"],
      ["zh-CN", "zh-CN", "界面语言"],
      ["French", "fr", "Langue de l’interface"],
      ["English", "en", "Interface language"],
    ] as const) {
      await search("Interface language")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("/ Language"))
      await search(searchTerm)
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes(label) && !frame.includes("/ Language"))
      expect(stored.language).toBe(language)
    }
    expect(writes).toBe(5)
    expect(stored.theme).toEqual({ name: "dusk" })
    expect(stored.mouse).toBe(false)
    await search("Interface language")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("/ Language"))
    await search("Spanish")
    const gate = Promise.withResolvers<void>()
    delay = gate.promise
    app.mockInput.pressEnter()
    await app.waitFor(() => pending)
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Settings") && !frame.includes("/ Language"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Settings"))
    gate.resolve()
    await app.waitFor(() => stored.language === "es")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Ajustes")
  } finally {
    app.renderer.destroy()
  }
})
