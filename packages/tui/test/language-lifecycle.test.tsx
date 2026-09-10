import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

test("language appears once in palette search and remains available through settings and slash commands", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({ state: state.path, config: { animations: false } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Commands"))
  const input = setup.renderer.currentFocusedEditor
  if (!(input instanceof InputRenderable)) throw new Error("Missing palette search field")
  input.value = "lang"
  const results = await setup.waitForFrame((frame) => frame.includes("Interface language"))
  expect(results.match(/Interface language/g)).toHaveLength(1)
  expect(results).toContain("Settings · Appearance")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Settings") && !frame.includes("Commands"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Interface language / Language"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Settings") && !frame.includes("/ Language"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Settings"))
  await setup.mockInput.typeText("/lang")
  await setup.waitForFrame((frame) => frame.includes("Interface language"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Interface language / Language"))
})

for (const width of [44, 100]) {
  test.each([
    ["zh-CN", "命令", "界面语言"],
    ["es", "comandos", "Idioma de la interfaz"],
    ["ko", "명령", "인터페이스 언어"],
    ["fr", "commandes", "Langue de l’interface"],
  ] as const)(
    `localized home opens the language command in %s at width ${width}`,
    async (language, commands, label) => {
      await using state = await tmpdir()
      await using setup = await createAppFixture({
        width,
        height: 35,
        state: state.path,
        config: { language, animations: false, keybinds: { "language.switch": "f6" } },
      })
      await setup.ready
      await setup.waitForFrame((frame) => frame.includes(commands))
      setup.mockInput.pressKey("F6")
      const picker = await setup.waitForFrame((frame) => frame.includes("Español") && frame.includes("한국어"))
      expect(picker).toContain(label)
      expect(picker).toContain("English")
      expect(picker).toContain("简体中文")
      expect(picker).toContain("Français")
      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => !frame.includes("Español") && frame.includes(commands))
    },
  )
}
