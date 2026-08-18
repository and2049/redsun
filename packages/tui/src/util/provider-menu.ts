// REDSUN DENSE: the pieces the model menus share for collapsing a provider.
//
// Both the model picker and the worker-model picker draw one row per provider
// and hide its models behind it. They build their option objects differently —
// one from the catalogue, one from a form's choices — but the grouping, the
// chevron and the count read the same in both, and that sameness is the point:
// they are supposed to look like one menu seen twice.

/** Groups items by provider, keeping the order each provider was first seen in. */
export function groupByProvider<T>(items: readonly T[], providerOf: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const providerID = providerOf(item)
    const existing = groups.get(providerID)
    if (existing) existing.push(item)
    else groups.set(providerID, [item])
  }
  return groups
}

/** `▾ Anthropic` when open, `▸ Anthropic` when closed. */
export function providerRowTitle(name: string, open: boolean) {
  return `${open ? "▾" : "▸"} ${name}`
}

/** What the row says it is hiding. */
export function providerRowDescription(count: number) {
  return count === 1 ? "1 model" : `${count} models`
}

/**
 * The provider half of a `providerID/modelID` value.
 *
 * Model ids can themselves contain slashes, so only the first one separates.
 * A value with no slash is not a model at all — the worker-model form sends one
 * such value to mean "go back to the configured default" — and those callers
 * use `undefined` to keep it out of the provider sections.
 */
export function providerOfValue(value: string) {
  const index = value.indexOf("/")
  return index > 0 ? value.slice(0, index) : undefined
}
