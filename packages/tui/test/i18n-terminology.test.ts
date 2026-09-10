import { expect, test } from "bun:test"
import { translate, locales } from "./fixture/languages"

test("AI token and reasoning labels follow upstream domain terminology", () => {
  expect(translate("zh-CN", "Tokens")).toBe("词元数")
  expect(translate("zh-CN", "Input Tokens")).toBe("输入词元")
  expect(translate("zh-CN", "Output Tokens")).toBe("输出词元")
  expect(translate("zh-CN", "Reasoning Tokens")).toBe("推理词元")
  expect(translate("zh-CN", "Cache Tokens (read/write)")).toBe("缓存词元（读/写）")
  expect(translate("zh-CN", "Thinking")).toBe("推理")
  expect(translate("fr", "Tokens")).toBe("Jetons")
  expect(translate("ko", "Tokens")).toBe("토큰")
  expect(translate("es", "Tokens")).toBe("Tokens")
})

test("keyboard hints and recovery commands retain their executable identifiers", () => {
  for (const locale of locales.slice(1)) {
    expect(translate(locale, "tab")).toBe("Tab")
    expect(
      translate(
        locale,
        "Backend identity has not been persisted; fix service configuration access and run remote disable to initialize it.",
      ),
    ).toContain("redsun remote disable")
    expect(translate(locale, "Tailscale Serve mapping conflicts; inspect tailscale serve status.")).toContain(
      "tailscale serve status",
    )
    const value = "Settings {{tokens}} /tmp/secret"
    expect(
      translate(locale, "◎ {{goal}}: {{condition}}", { goal: translate(locale, "Goal"), condition: value }),
    ).toContain(value)
  }
})
