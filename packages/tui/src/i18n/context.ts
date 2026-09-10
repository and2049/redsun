import { createContext, createSignal, useContext } from "solid-js"
import { resolveCatalogs, type Contribution } from "./registry"

export function createLanguageRegistry() {
  const [snapshot, setSnapshot] = createSignal(resolveCatalogs([]))
  return {
    snapshot,
    publish: (contributions: readonly Contribution[]) => setSnapshot(resolveCatalogs(contributions)),
  }
}

export const LanguageContext = createContext<() => string>(() => "en")
export const LanguageRegistryContext = createContext<ReturnType<typeof createLanguageRegistry>>()

const english = resolveCatalogs([])
export function useLanguageRegistry() {
  return useContext(LanguageRegistryContext)
}

export function useLanguageSnapshot() {
  const registry = useLanguageRegistry()
  return () => registry?.snapshot() ?? english
}
