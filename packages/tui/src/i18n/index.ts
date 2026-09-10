import { useContext } from "solid-js"
import { LanguageContext } from "./context"
import { translate, type Values } from "./translate"

export { languages, locales, type Locale } from "./locale"
export { translate } from "./translate"

export function useLanguage() {
  const locale = useContext(LanguageContext)
  return {
    locale,
    t: (message: string, values?: Values): string => translate(locale(), message, values),
  }
}
