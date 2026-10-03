import type { Catalog } from "@opencode/plugin/tui/i18n"
import { auditCatalog } from "../src/i18n/audit"
import { english } from "../src/i18n/source"
import manifest from "../src/i18n/manifest.json"

const [command, locale, file] = Bun.argv.slice(2)
if (command === "manifest") {
  console.log(JSON.stringify(manifest, null, 2))
} else if (command === "template") {
  console.log(JSON.stringify(english, null, 2))
} else if (command === "check" && locale && file) {
  const input: unknown = await Bun.file(file).json()
  const result = auditCatalog(locale, input as Catalog)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.invalid.length ? 1 : 0
} else {
  console.error("Usage: bun tools/i18n.ts manifest | template | check <locale> <catalog.json>")
  process.exitCode = 1
}
