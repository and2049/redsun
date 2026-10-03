import { createContext, createSignal, useContext } from "solid-js"
import { resolveCatalogs, type Contribution } from "./registry"

export function createLanguageRegistry() {
  const [snapshot, setSnapshot] = createSignal(resolveCatalogs([]))
  let published: readonly Contribution[] = []
  return {
    snapshot,
    publish(contributions: readonly Contribution[]) {
      if (
        published.length === contributions.length &&
        contributions.every(
          (item, index) => item.plugin === published[index].plugin && item.value === published[index].value,
        )
      )
        return
      const next = resolveCatalogs(contributions)
      published = contributions.slice()
      setSnapshot(next)
    },
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
