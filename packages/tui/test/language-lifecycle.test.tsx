import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

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
