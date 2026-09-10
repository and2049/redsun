import { expect, test } from "bun:test"
import { Schema } from "effect"
import ts from "typescript"
import { fileURLToPath } from "node:url"
import { Info, resolve } from "../src/config"
import { locales } from "../src/i18n/locale"
import { catalog } from "../src/i18n/catalog"
import { ui } from "../src/i18n/ui"
import { session } from "../src/i18n/session"
import { settings } from "../src/i18n/settings"
import { application } from "../src/i18n/application"
import { remote } from "../src/i18n/remote"
import { messages, translate } from "../src/i18n/translate"

test("accepts supported interface languages without changing other preferences", () => {
  const decode = Schema.decodeUnknownSync(Info)
  for (const language of locales) {
    const input = decode({ language, theme: { name: "dusk" }, mouse: false })
    expect(resolve(input, { terminalSuspend: true })).toMatchObject(input)
  }
  expect(() => decode({ language: "unknown" })).toThrow()
  expect(translate(resolve({}, { terminalSuspend: true }).language ?? "en", "Interface language")).toBe(
    "Interface language",
  )
})

test("catalogs contain complete translations with the original interpolation parameters", () => {
  const placeholders = (text: string) => [...new Set(text.match(/\{\{\w+\}\}/g) ?? [])].sort()
  for (const entries of [catalog, ui, session, settings, application, remote]) {
    expect(Object.keys(entries).length).toBeGreaterThan(0)
    for (const [source, translations] of Object.entries(entries)) {
      expect(translations, source).toHaveLength(4)
      translations.forEach((text, index) => {
        expect(text.trim().length, `${source}: ${locales[index + 1]}`).toBeGreaterThan(0)
        expect(placeholders(text), `${source}: ${locales[index + 1]}`).toEqual(placeholders(source))
      })
    }
  }
})

test("uses English fallback and safely interpolates values without translating their contents", () => {
  expect(translate("es", "Interface language")).toBe("Idioma de la interfaz")
  expect(translate("ko", "Interface language")).toBe("인터페이스 언어")
  expect(translate("fr", "Unknown plugin label")).toBe("Unknown plugin label")
  expect(translate("zh-CN", "constructor")).toBe("constructor")
  expect(translate("fr", "{{value}} {{missing}}", { value: "Settings {{other}} $&" })).toBe(
    "Settings {{other}} $& {{missing}}",
  )
  expect(translate("en", "{{count}}", { count: 0 })).toBe("0")
  expect(translate("es", "{{constructor}}", {})).toBe("{{constructor}}")
  for (const message of Object.keys(messages)) expect(translate("en", message)).toBe(message)
  expect(translate("zh-CN", "Select model")).toBe("选择模型")
  expect(translate("fr", "Search")).toBe("Rechercher")
  expect(translate("fr", "Settings")).not.toBe("Settings")
  expect(translate("fr", "Settings user option")).toBe("Settings user option")
})

test("localized counts use whole messages instead of English plural suffixes", () => {
  expect(translate("zh-CN", "{{count}} models", { count: 2 })).toBe("2 个模型")
  expect(translate("ko", "{{count}} models", { count: 2 })).toBe("모델 2개")
  expect(translate("es", "{{count}} MCP servers", { count: 2 })).toBe("2 servidores MCP")
  expect(translate("fr", "{{count}} MCP servers", { count: 2 })).toBe("2 serveurs MCP")
  expect(translate("en", "{{count}} model", { count: 1 })).toBe("1 model")
})

test("every explicitly localized string has a catalog entry", async () => {
  const missing: string[] = []
  const cwd = fileURLToPath(new URL("../src", import.meta.url))
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd, absolute: true })) {
    const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression
        const message = node.arguments[0]
        if (ts.isIdentifier(name) && name.text === "t" && message && ts.isStringLiteralLike(message)) {
          if (message.text && !Object.hasOwn(messages, message.text)) missing.push(`${file}: ${message.text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(missing).toEqual([])
})
