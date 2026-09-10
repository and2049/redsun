import { expect, test } from "bun:test"
import { Schema } from "effect"
import ts from "typescript"
import { fileURLToPath } from "node:url"
import { Info, resolve } from "../src/config"
import { source, sourceIDs } from "../src/i18n/source"
import { canonicalLocale } from "../src/i18n/locale"
import { bundled, contributions, locales, translate } from "./fixture/languages"

test("locale configuration accepts well-formed plugin locales independently of installation", () => {
  const decode = Schema.decodeUnknownSync(Info)
  for (const language of [...locales, "de", "pl", "pt-BR", "zh-Hant"]) {
    const input = decode({ language, theme: { name: "dusk" }, mouse: false })
    expect(resolve(input, { terminalSuspend: true })).toMatchObject(input)
  }
  for (const language of ["", "not_a_locale", "../de"]) expect(() => decode({ language })).toThrow()
  expect(resolve(decode({ language: "pt-br" }), { terminalSuspend: true }).language).toBe("pt-BR")
  expect(canonicalLocale("zh-cn")).toBe("zh-CN")
})

test("builtin language plugins are complete and preserve source parameters", () => {
  expect(bundled.diagnostics).toEqual([])
  const keys = Object.keys(source).sort()
  for (const { value } of contributions) expect(Object.keys(value.catalogs.tui).sort()).toEqual(keys)
  expect(contributions).toHaveLength(4)
  expect(keys.length).toBeGreaterThan(500)
})

test("fallback interpolates values once and never translates caller content", () => {
  expect(translate("es", "settings.language.title")).toBe("Idioma de la interfaz")
  expect(translate("ko", "settings.language.title")).toBe("인터페이스 언어")
  expect(translate("fr", "Unknown plugin label")).toBe("Unknown plugin label")
  expect(translate("zh-CN", "constructor")).toBe("constructor")
  expect(translate("fr", "{{value}} {{missing}}", { value: "Settings {{other}} $&" })).toBe(
    "Settings {{other}} $& {{missing}}",
  )
  expect(translate("en", "{{count}}", { count: 0 })).toBe("0")
  expect(translate("es", "{{constructor}}", {})).toBe("{{constructor}}")
  for (const [id, entry] of Object.entries(source)) {
    if (typeof entry.message === "string") expect(translate("en", id)).toBe(entry.message)
    expect(entry.legacy.every((text) => sourceIDs.get(text) === id)).toBeTrue()
  }
})

test("counts select plural forms using the translation's locale", () => {
  expect(translate("zh-CN", "models.count", { count: 2 })).toBe("2 个模型")
  expect(translate("ko", "models.count", { count: 2 })).toBe("모델 2개")
  expect(translate("es", "mcp.count", { count: 2 })).toBe("2 servidores MCP")
  expect(translate("fr", "models.count", { count: 0 })).toBe("0 modèle")
  expect(translate("en", "models.count", { count: 1 })).toBe("1 model")
})

test("every explicitly localized literal uses a stable manifest ID", async () => {
  const missing: string[] = []
  const cwd = fileURLToPath(new URL("../src", import.meta.url))
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd, absolute: true })) {
    if (file.replaceAll("\\", "/").includes("/i18n/")) continue
    const ast = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true)
    function check(node: ts.Expression): void {
      if (ts.isStringLiteralLike(node) && node.text && !Object.hasOwn(source, node.text))
        missing.push(`${file}: ${node.text}`)
      if (ts.isConditionalExpression(node)) {
        check(node.whenTrue)
        check(node.whenFalse)
      }
    }
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression
        if (ts.isIdentifier(name) && name.text === "t" && node.arguments[0]) check(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  expect(missing).toEqual([])
})
