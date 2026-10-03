import type { ParentProps } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { LanguageContribution, Values } from "@opencode/plugin/tui/i18n"
import Chinese from "../../src/feature-plugins/languages/zh-CN"
import Spanish from "../../src/feature-plugins/languages/es"
import Korean from "../../src/feature-plugins/languages/ko"
import French from "../../src/feature-plugins/languages/fr"
import { createLanguageRegistry, LanguageRegistryContext } from "../../src/i18n/context"
import { normalizeContribution, resolveCatalogs, interpolate, type Contribution } from "../../src/i18n/registry"
import { source, sourceIDs, sourceKey } from "../../src/i18n/source"

export const contributions: Contribution[] = []
for (const plugin of [Chinese, Spanish, Korean, French]) {
  const context = {
    i18n: {
      register(value: LanguageContribution) {
        contributions.push({ plugin: plugin.id, value: normalizeContribution(value) })
        return () => {}
      },
    },
  } as Plugin.Context
  await plugin.setup(context)
}
export const locales = ["en", ...contributions.map(({ value }) => value.locale)]
export const bundled = resolveCatalogs(contributions)
export function translate(locale: string, message: string, values?: Values): string {
  if (!message.includes(":") && !Object.hasOwn(source, message) && !sourceIDs.has(message))
    return interpolate(message, values)
  return bundled.t(locale, sourceKey(message), values)
}

export function TestLanguages(props: ParentProps) {
  const registry = createLanguageRegistry()
  registry.publish(contributions)
  return <LanguageRegistryContext.Provider value={registry}>{props.children}</LanguageRegistryContext.Provider>
}
