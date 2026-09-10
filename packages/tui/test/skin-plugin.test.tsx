import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import type { Config } from "../src/config"

const skin = path.join(import.meta.dir, "fixture", "skin")

test("a launch-scoped skin plugin owns the home logo, backdrop and theme without touching config", async () => {
  let config: Config.Info = {
    animations: false,
    theme: { name: "dawn" },
    keybinds: { "theme.switch": "f8", "opencode.settings": "f9", "plugins.list": "f7", "command.palette.show": "f10" },
  }
  let updates = 0
  await using app = await createAppFixture({
    width: 100,
    height: 30,
    plugins: [skin],
    configService: {
      get: async () => config,
      update: async (update) => {
        updates++
        const draft = structuredClone(config)
        update(draft)
        config = draft
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

  const home = await app.waitForFrame(
    (frame) =>
      frame.includes("SKIN LOGO test") &&
      frame.includes("mode insert theme skin bg #123456") &&
      frame.includes("dims 100x30") &&
      /backdrop 100x2\d/.test(frame),
    { maxPasses: 200 },
  )
  expect(home).not.toContain("██╗")

  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("mode normal theme skin-warm bg #654321"), { maxPasses: 200 })
  app.mockInput.pressKey("i")
  await app.waitForFrame((frame) => frame.includes("mode insert theme skin bg #123456"), { maxPasses: 200 })

  app.resize(80, 24)
  await app.waitForFrame((frame) => frame.includes("dims 80x24") && /backdrop 80x2\d/.test(frame), {
    maxPasses: 200,
  })

  app.mockInput.pressKey("F8")
  await app.renderOnce()
  await app.renderOnce()
  expect(app.captureCharFrame()).not.toContain("Dark")

  app.mockInput.pressKey("F10")
  await app.waitForFrame((frame) => frame.includes("Commands"), { maxPasses: 200 })
  await search("theme")
  expect(app.captureCharFrame()).not.toContain("Switch theme")
  app.mockInput.pressEscape()

  app.mockInput.pressKey("F9")
  const settings = await app.waitForFrame((frame) => frame.includes("Animations"), { maxPasses: 200 })
  expect(settings).not.toContain("Theme")
  app.mockInput.pressEscape()
  expect(updates).toBe(0)

  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("test.skin"), { maxPasses: 200 })
  await search("test.skin")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("inactive"), { maxPasses: 200 })
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("██╗") && !frame.includes("SKIN LOGO"), { maxPasses: 200 })

  app.mockInput.pressKey("F9")
  const unlocked = await app.waitForFrame((frame) => frame.includes("Theme") && frame.includes("dawn"), {
    maxPasses: 200,
  })
  expect(unlocked).toContain("Animations")
  expect(config.theme?.name).toBe("dawn")
})

test("a plugin declaring a newer API than the host fails setup and names both versions", async () => {
  const future = path.join(import.meta.dir, "fixture", "skin-future")
  await using app = await createAppFixture({
    plugins: [future],
    config: { animations: false, keybinds: { "plugins.list": "f7" } },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Plugin failed"), { maxPasses: 200 })
  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("test.skin.future"), {
    maxPasses: 200,
  })
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("plugin API 99") && frame.includes("supports 1"), {
    maxPasses: 200,
  })
})
