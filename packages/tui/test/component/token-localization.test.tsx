import { testRender } from "@opentui/solid"
import { stringWidth } from "../../src/util/string-width"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { SessionMessageAssistant } from "@opencode/client/promise"
import { ConfigProvider, resolve } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { LanguageContext } from "../../src/i18n/context"
import type { Locale } from "../../src/i18n/locale"
import { TurnTokenUsage } from "../../src/routes/session"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

test("token diagnostics switch language live and align translated CJK headers with numeric columns", async () => {
  const [language, setLanguage] = createSignal<Locale>("en")
  const message: SessionMessageAssistant = {
    type: "assistant",
    id: "msg_tokens",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [],
    time: { created: 0 },
    finish: "tool-calls",
    cost: 0,
    tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 45, write: 0 } },
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={resolve({ debug: { turn_tokens: true } }, { terminalSuspend: true })}>
          <Keymap.Provider>
            <ThemeProvider source={emptyThemeSource}>
              <LanguageContext.Provider value={language}>
                <TurnTokenUsage messageIDs={[message.id]} message={() => message} />
              </LanguageContext.Provider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 12 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Tokens: 1 step · 15 new · 45 cached · 60 total"))
    await app.mockMouse.click(3, 0)
    await app.waitForFrame((frame) => frame.includes("tool-call"))
    for (const [locale, title, header] of [
      ["zh-CN", "词元数", "新增词元"],
      ["es", "Tokens", "Tokens nuevos"],
      ["ko", "토큰", "신규 토큰"],
      ["fr", "Jetons", "Nouveaux jetons"],
    ] as const) {
      setLanguage(locale)
      const frame = await app.waitForFrame((frame) => frame.includes(header))
      expect(frame).toContain(title)
      expect(frame).toContain("tool-call")
      expect(frame).toContain("15")
      expect(frame).toContain("45")
      expect(frame).toContain("60")
      expect(frame).not.toContain("令牌")
      const heading = frame.split("\n").find((line) => line.includes(header))!
      const row = frame.split("\n").find((line) => line.includes("tool-call"))!
      expect(stringWidth(heading.slice(0, heading.indexOf(header) + header.length))).toBe(
        stringWidth(row.slice(0, row.indexOf("15") + 2)),
      )
    }
  } finally {
    app.renderer.destroy()
  }
})
