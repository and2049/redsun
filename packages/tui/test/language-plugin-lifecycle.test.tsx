import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { CliRenderEvents } from "@opentui/core"
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
  const code = (fail = false) => `
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
    ${fail ? 'throw new Error("language setup failed")' : ""}
    context.ui.slot({ append: "home.footer", render: () => <text>{context.i18n.t("test.widget:hello", { value: "Settings" })}</text> })
    return () => { if (existsSync(${JSON.stringify(stale)})) return; setTimeout(() => {
      context.i18n.register({ locale: "de", catalogs: { tui: { "settings.language.title": "Stale activation" } } })
      void Bun.write(${JSON.stringify(stale)}, "called")
    }, 30) }
  }
}
`
  await Bun.write(entry, code())
  let config: Config.Info = { language: "de", animations: false, keybinds: { "language.switch": "f6" } }
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
  await Bun.write(entry, code(true))
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
})
