import { expect, test } from "bun:test"
import type { LanguageContribution, Message } from "@opencode/plugin/tui/i18n"
import { createLanguageRegistry } from "../src/i18n/context"
import { normalizeContribution, resolveCatalogs, type Contribution } from "../src/i18n/registry"
import { auditCatalog } from "../src/i18n/audit"

function pack(plugin: string, locale: string, messages: Record<string, Message>, fallback?: string): Contribution {
  return {
    plugin,
    value: normalizeContribution({ locale, name: locale, nativeName: locale, fallback, catalogs: { tui: messages } }),
  }
}
const title = "settings.language.title"
const cache = "session.usage.cache"

test("author audit accepts partial catalogs, reports invalid entries, and treats newer keys as unmatched", () => {
  const report = auditCatalog("de", { [title]: "Sprache", [cache]: "Cache {{invalid}}", future: "Future" })
  expect(report.translated).toBe(1)
  expect(report.invalid).toHaveLength(1)
  expect(report.unmatched).toHaveLength(1)
  expect(report.missing).toContain(cache)
  expect(() => auditCatalog("de", null as unknown as Record<string, Message>)).toThrow()
})

test("partial packs layer per key, preserve source defaults, and restore overridden translations", () => {
  const base = pack("base", "de", { [title]: "Sprache", [cache]: "Cache {{percent}} %" })
  const overlay = pack("overlay", "de", { [title]: "Oberflächensprache" })
  const registry = createLanguageRegistry()
  registry.publish([base, overlay])
  expect(registry.snapshot().t("de", `tui:${title}`)).toBe("Oberflächensprache")
  expect(registry.snapshot().t("de", `tui:${cache}`, { percent: 90 })).toBe("Cache 90 %")
  expect(registry.snapshot().t("de", "tui:models.count", { count: 2 })).toBe("2 models")
  expect(registry.snapshot().languages()[1].providers).toEqual(["base", "overlay"])
  registry.publish([base])
  expect(registry.snapshot().t("de", `tui:${title}`)).toBe("Sprache")
  registry.publish([])
  expect(registry.snapshot().t("de", `tui:${title}`)).toBe("Interface language")
  expect(registry.snapshot().languages("de").at(-1)).toMatchObject({ locale: "de", available: false })
})

test("fallbacks are explicit, script aware, and cycle safe", () => {
  const catalog = resolveCatalogs([
    pack("portuguese", "pt", { [title]: "Idioma" }),
    pack("brazilian", "pt-br", {}, "pt"),
    pack("chinese", "zh-CN", { [title]: "界面语言" }),
    pack("a", "de", {}, "fr"),
    pack("b", "fr", {}, "de"),
  ])
  expect(catalog.t("pt-BR", `tui:${title}`)).toBe("Idioma")
  expect(catalog.t("zh-TW", `tui:${title}`)).toBe("Interface language")
  expect(catalog.t("de", `tui:${title}`)).toBe("Interface language")
})

test("unchanged inventories preserve snapshot identity while reorders and replacements publish", () => {
  const registry = createLanguageRegistry()
  const base = pack("base", "de", { [title]: "Sprache" })
  const overlay = pack("overlay", "de", { [title]: "Oberflächensprache" })
  registry.publish([base, overlay])
  const initial = registry.snapshot()
  registry.publish([{ ...base }, { ...overlay }])
  expect(registry.snapshot()).toBe(initial)
  registry.publish([overlay, base])
  expect(registry.snapshot()).not.toBe(initial)
  expect(registry.snapshot().t("de", `tui:${title}`)).toBe("Sprache")
  registry.publish([overlay, pack("base", "de", { [title]: "Neue Sprache" })])
  expect(registry.snapshot().t("de", `tui:${title}`)).toBe("Neue Sprache")
})

test("translations can pluralize string sources or use strings for plural sources", () => {
  const source = {
    plugin: "widget",
    value: normalizeContribution({
      locale: "en",
      catalogs: {
        widget: {
          attempts: "{{name}}: {{count}} more",
          files: { plural: "count", forms: { one: "{{name}}: one file", other: "{{name}}: many files" } },
        },
      },
    }),
  }
  const catalog = resolveCatalogs([
    source,
    {
      plugin: "pl",
      value: normalizeContribution({
        locale: "pl",
        name: "Polish",
        nativeName: "Polski",
        catalogs: {
          widget: {
            attempts: {
              plural: "count",
              forms: {
                one: "{{name}}: jeszcze jedna",
                few: "{{name}}: jeszcze {{count}} próby",
                other: "{{name}}: jeszcze {{count}} prób",
              },
            },
          },
        },
      }),
    },
    pack("zh", "zh-CN", { "models.count": "{{count}} 个模型" }),
    {
      plugin: "ja",
      value: normalizeContribution({
        locale: "ja",
        name: "Japanese",
        nativeName: "日本語",
        catalogs: { widget: { files: "{{name}}: {{count}} 件" } },
      }),
    },
  ])
  expect(catalog.diagnostics).toEqual([])
  expect(catalog.t("pl", "widget:attempts", { count: 1, name: "Settings" })).toBe("Settings: jeszcze jedna")
  expect(catalog.t("pl", "widget:attempts", { count: 2, name: "Settings" })).toBe("Settings: jeszcze 2 próby")
  expect(catalog.t("pl", "widget:attempts", { count: 5, name: "Settings" })).toBe("Settings: jeszcze 5 prób")
  expect(catalog.t("pl", "widget:attempts", { count: "2", name: "Settings" })).toBe("Settings: 2 more")
  expect(catalog.t("zh-CN", "tui:models.count", { count: 2 })).toBe("2 个模型")
  expect(catalog.t("ja", "widget:files", { count: 2, name: "Settings" })).toBe("Settings: 2 件")
  const bad = resolveCatalogs([
    source,
    {
      plugin: "bad",
      value: normalizeContribution({
        locale: "pl",
        name: "Polish",
        nativeName: "Polski",
        catalogs: {
          widget: {
            attempts: { plural: "unknown", forms: { other: "{{name}} {{count}}" } },
            files: { plural: "name", forms: { other: "{{count}}" } },
          },
        },
      }),
    },
  ])
  expect(bad.diagnostics).toHaveLength(2)
  expect(auditCatalog("zh-CN", { "models.count": "{{count}} 个模型" }).invalid).toEqual([])
})

test("bad translations do not hide valid lower layers and forward keys are diagnosed", () => {
  const catalog = resolveCatalogs([
    pack("base", "de", { [cache]: "Cache {{percent}} %" }),
    pack("bad", "de", { [cache]: "Cache {{wrong}}", [title]: "", future: "Zukunft" }),
  ])
  expect(catalog.t("de", `tui:${cache}`, { percent: 0 })).toBe("Cache 0 %")
  expect(catalog.t("de", `tui:${title}`)).toBe("Interface language")
  expect(catalog.diagnostics).toHaveLength(3)
  expect(catalog.diagnostics.every((item) => item.plugin === "bad")).toBeTrue()
})

test("plural rules support few/many/zero and fallback uses its own locale", () => {
  const key = "session.subagents.view"
  const plural = (forms: { other: string } & Record<string, string>): Message => ({ plural: "count", forms })
  const catalog = resolveCatalogs([
    pack("polish", "pl", {
      [key]: plural({
        one: "jeden {{count}}",
        few: "kilka {{count}}",
        many: "wiele {{count}}",
        other: "inne {{count}}",
      }),
    }),
    pack("arabic", "ar", { [key]: plural({ zero: "brak", two: "para", other: "{{count}}" }) }),
    pack("regional", "pl-PL", {}, "pl"),
  ])
  expect(catalog.diagnostics).toEqual([])
  expect(catalog.t("pl", `tui:${key}`, { count: 1 })).toBe("jeden 1")
  expect(catalog.t("pl-PL", `tui:${key}`, { count: 2 })).toBe("kilka 2")
  expect(catalog.t("pl", `tui:${key}`, { count: 5 })).toBe("wiele 5")
  expect(catalog.t("pl", `tui:${key}`, { count: 1.5 })).toBe("inne 1.5")
  expect(catalog.t("ar", `tui:${key}`, { count: 0 })).toBe("brak")
  expect(catalog.t("ar", `tui:${key}`, { count: 2 })).toBe("para")
  expect(catalog.t("ar", `tui:${key}`, { count: 3 })).toBe("3")
  expect(catalog.t("pl", "tui:models.count", { count: 2 })).toBe("2 models")
  expect(catalog.t("pl", `tui:${key}`, { count: "2" })).toBe("view 2 subagents")
  expect(catalog.t("pl", `tui:${key}`)).toBe("view {{count}} subagents")
})

test("external namespaces validate when defaults arrive, preserve data, and tolerate prototype keys", () => {
  const translation = {
    plugin: "pack",
    value: normalizeContribution({
      locale: "de",
      name: "German",
      nativeName: "Deutsch",
      catalogs: { widget: JSON.parse('{"title":"Titel {{value}}","__proto__":"Prototyp"}') },
    }),
  }
  const defaults = {
    plugin: "widget",
    value: normalizeContribution({
      locale: "en",
      catalogs: { widget: JSON.parse('{"title":"Title {{value}}","__proto__":"Prototype"}') },
    }),
  }
  expect(resolveCatalogs([translation]).diagnostics).toHaveLength(2)
  const catalog = resolveCatalogs([translation, defaults])
  expect(catalog.diagnostics).toEqual([])
  expect(catalog.t("de", "widget:title", { value: "{{other}} $&" })).toBe("Titel {{other}} $&")
  expect(catalog.t("de", "widget:__proto__")).toBe("Prototyp")
  expect(catalog.t("de", "widget:constructor")).toBe("widget:constructor")
  expect(catalog.t("fr", "widget:title", { value: "Settings" })).toBe("Title Settings")
})

test("normalization clones contributions and requires paired metadata and valid locale tags", () => {
  const original = {
    locale: "pt-br",
    name: "Portuguese",
    nativeName: "Português",
    catalogs: { tui: { [title]: "Idioma" } },
  }
  const normalized = normalizeContribution(original)
  original.catalogs.tui[title] = "Changed"
  expect(normalized.locale).toBe("pt-BR")
  expect(normalized.catalogs.tui[title]).toBe("Idioma")
  expect(() => normalizeContribution({ ...original, locale: "pt_br" })).toThrow()
  expect(() => normalizeContribution({ ...original, nativeName: undefined })).toThrow()
  expect(() => normalizeContribution({ ...original, fallback: "" })).toThrow()
  expect(() => normalizeContribution({ ...original, catalogs: { "bad:namespace": {} } })).toThrow()
})

test("host English survives plugin overrides and separate roots keep independent inventories", () => {
  const first = createLanguageRegistry()
  const second = createLanguageRegistry()
  first.publish([pack("de", "de", { [title]: "Sprache" }), pack("override", "en", { [title]: "Broken" })])
  expect(first.snapshot().t("en", `tui:${title}`)).toBe("Interface language")
  expect(first.snapshot().diagnostics).toHaveLength(1)
  expect(second.snapshot().t("de", `tui:${title}`)).toBe("Interface language")
})

test("catalog-only contributions become available when a descriptor is added", () => {
  const value: LanguageContribution = { locale: "de", catalogs: { tui: { [title]: "Sprache" } } }
  const contribution = { plugin: "messages", value: normalizeContribution(value) }
  expect(resolveCatalogs([contribution]).languages("de").at(-1)).toMatchObject({
    available: false,
    providers: ["messages"],
  })
  const descriptor = pack("metadata", "de", {})
  expect(resolveCatalogs([contribution, descriptor]).t("de", `tui:${title}`)).toBe("Sprache")
})
