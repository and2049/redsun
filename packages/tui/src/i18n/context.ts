import { createContext } from "solid-js"
import type { Locale } from "./locale"

export const LanguageContext = createContext<() => Locale>((): Locale => "en")
