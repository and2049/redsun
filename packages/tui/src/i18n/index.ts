import { useContext } from "solid-js"
import { LanguageContext, useLanguageSnapshot } from "./context"
import { sourceKey, sourceIDs, source } from "./source"
import { interpolate } from "./registry"
import type { Values } from "./translate"

export { type Locale } from "./locale"
export { translate } from "./translate"

export function useLanguage() {
  const locale = useContext(LanguageContext)
  const snapshot = useLanguageSnapshot()
  return {
    locale,
    languages: () => snapshot().languages(locale()),
    diagnostics: () => snapshot().diagnostics,
    t: (message: string, values?: Values): string =>
      !message.includes(":") && !Object.hasOwn(source, message) && !sourceIDs.has(message)
        ? interpolate(message, values)
        : snapshot().t(locale(), sourceKey(message), values),
  }
}
