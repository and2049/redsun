import type { Catalog } from "@opencode/plugin/tui/i18n"
import { source } from "./source"
import { normalizeContribution, resolveCatalogs } from "./registry"

export function auditCatalog(locale: string, catalog: Catalog) {
  const value = normalizeContribution({ locale, name: locale, nativeName: locale, catalogs: { tui: catalog } })
  const diagnostics = resolveCatalogs([{ plugin: "catalog", value }]).diagnostics
  const invalid = diagnostics.filter((item) => item.message !== "No source message registered")
  const rejected = new Set(invalid.map((item) => item.key.slice("tui:".length)))
  const missing = Object.keys(source).filter((key) => !Object.hasOwn(catalog, key) || rejected.has(key))
  return {
    locale: value.locale,
    translated: Object.keys(source).length - missing.length,
    total: Object.keys(source).length,
    missing,
    invalid,
    unmatched: diagnostics.filter((item) => item.message === "No source message registered"),
  }
}
