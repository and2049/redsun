import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import type { Config } from "../src/config"

test("a discovered language plugin adds a locale, reloads helpers, restores failures, and preserves selection on disable", async () => {
  await using tmp = await tmpdir()
  const configDirectory = path.join(tmp.path, "config")
  const plugin = path.join(configDirectory, "plugins", "language-de")
  await mkdir(plugin, { recursive: true })
  const helper = path.join(plugin, "messages.ts")
  const entry = path.join(plugin, "tui.tsx")
  const configPath = path.join(configDirectory, "cli.json")
  const stale = path.join(tmp.path, "old-context-called")
  const messages = (title: string) =>
    `export const messages = { "settings.language.title": ${JSON.stringify(title)} }\n`
  await Bun.write(helper, messages("Sprachauswahl"))
  const code = (failure?: "setup" | "structure") => `
import { messages } from "./messages"
import { existsSync } from "node:fs"
export default {
  id: "test.language.de",
  setup(context) {
    context.i18n.register({ locale: "de", name: "German", nativeName: "Deutsch", catalogs: { tui: messages } })
    const discard = context.i18n.register({ locale: "de", catalogs: { tui: { "settings.language.title": "Discarded contribution" } } })
    discard()
    discard()
    context.i18n.register({ locale: "en", catalogs: { "test.widget": { hello: "Widget {{value}}" } } })
    context.i18n.register({ locale: "de", catalogs: { "test.widget": { hello: "Anzeige {{value}}" } } })
    ${failure === "setup" ? 'throw new Error("language setup failed")' : failure === "structure" ? 'context.i18n.register({ locale: "de", catalogs: null })' : ""}
    context.ui.slot({ append: "home.footer", render: () => <text>{context.i18n.t("test.widget:hello", { value: "Settings" })} · base: {messages["settings.language.title"]}</text> })
    return () => { if (existsSync(${JSON.stringify(stale)})) return; setTimeout(() => {
      context.i18n.register({ locale: "de", catalogs: { tui: { "settings.language.title": "Stale activation" } } })
      void Bun.write(${JSON.stringify(stale)}, "called")
    }, 30) }
  }
}
`
  await Bun.write(entry, code())
  let config: Config.Info = {
    language: "de",
    animations: false,
    keybinds: { "language.switch": "f6", "plugins.list": "f7" },
  }
  await Bun.write(configPath, JSON.stringify(config))
  const save = async (plugins: string[]) => {
    config = { ...config, plugins }
    await Bun.write(configPath, JSON.stringify(config))
  }
  await using app = await createAppFixture({
    state: path.join(tmp.path, "state"),
    configDirectory,
    height: 40,
    configService: {
      path: configPath,
      get: async () => JSON.parse(await Bun.file(configPath).text()) as Config.Info,
      update: async (update) => {
        const draft = structuredClone(config)
        update(draft)
        config = draft
        await Bun.write(configPath, JSON.stringify(config))
        return config
      },
    },
  })
  await app.ready
  async function search(value: string) {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof InputRenderable)) throw new Error("Missing search field")
    input.value = value
    await app.renderOnce()
  }
  await app.waitForFrame((frame) => frame.includes("Anzeige Settings"), { maxPasses: 200 })
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes("Sprachauswahl / Language") && frame.includes("Deutsch"))
  const frames: string[] = []
  const capture = () => {
    frames.push(app.captureCharFrame())
  }
  app.renderer.on(CliRenderEvents.FRAME, capture)
  await Bun.write(helper, messages("Sprache aktualisiert"))
  await app.waitForFrame((frame) => frame.includes("Sprache aktualisiert / Language"), { maxPasses: 200 })
  await app.waitFor(() => existsSync(stale))
  expect(app.captureCharFrame()).toContain("Sprache aktualisiert / Language")
  await Bun.write(entry, code("setup"))
  await app.waitForFrame((frame) => frame.includes("Plugin failed"), { maxPasses: 200 })
  expect(app.captureCharFrame()).toContain("Sprache aktualisiert / Language")
  app.renderer.off(CliRenderEvents.FRAME, capture)
  expect(
    frames.some(
      (frame) =>
        frame.includes("Interface language / Language") ||
        frame.includes("Stale activation") ||
        frame.includes("Discarded contribution"),
    ),
  ).toBeFalse()
  await Bun.write(entry, code())
  await save(["-test.language.de"])
  await app.waitForFrame(
    (frame) => frame.includes("Language plugin unavailable") && frame.includes("Interface language / Language"),
    { maxPasses: 200 },
  )
  expect(config.language).toBe("de")
  await save([])
  await app.waitForFrame(
    (frame) => frame.includes("Sprache aktualisiert / Language") && !frame.includes("Language plugin unavailable"),
    { maxPasses: 200 },
  )
  expect(config.language).toBe("de")
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("/ Language"))
  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("test.language.de"))
  await search("test.language.de")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("inactive"))
  app.mockInput.pressEscape()
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes("Language plugin unavailable"))
  await search("de")
  app.mockInput.pressEnter()
  expect(config.language).toBe("de")
  app.mockInput.pressEscape()
  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Plugins"))
  await search("test.language.de")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Anzeige Settings"))
  app.mockInput.pressEscape()
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes("Sprache aktualisiert / Language"))
  await search("English")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Widget Settings") && !frame.includes("/ Language"))
  expect(config.language).toBe("en")
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes("Interface language / Language"))
  await search("Deutsch")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Anzeige Settings") && !frame.includes("/ Language"))
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes("Sprache aktualisiert / Language"))

  const overlay = path.join(configDirectory, "plugins", "z-language-overlay")
  await mkdir(overlay, { recursive: true })
  await Bun.write(
    path.join(overlay, "tui.ts"),
    `export default { id: "test.language.overlay", setup(context) {
    context.i18n.register({ locale: "de", catalogs: { tui: { "settings.language.title": "Overlay Sprache" } } })
  } }`,
  )
  await app.waitForFrame((frame) => frame.includes("Overlay Sprache / Language"), { maxPasses: 200 })
  await Bun.write(helper, messages("Neue Basissprache"))
  await app.waitForFrame((frame) => frame.includes("base: Neue Basissprache"), { maxPasses: 200 })
  expect(app.captureCharFrame()).toContain("Overlay Sprache / Language")
  await save(["-test.language.overlay"])
  await app.waitForFrame((frame) => frame.includes("Neue Basissprache / Language"), { maxPasses: 200 })
  await Bun.write(entry, code("structure"))
  await app.waitForFrame((frame) => frame.includes("Plugin failed"), { maxPasses: 200 })
  expect(app.captureCharFrame()).toContain("Neue Basissprache / Language")
  app.mockInput.pressEscape()
  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Plugins"))
  await search("test.language.de")
  await app.waitForFrame((frame) => frame.includes("test.language.de") && frame.includes("failed, local"))
})
