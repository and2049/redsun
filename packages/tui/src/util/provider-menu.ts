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

export function providerRowTitle(name: string, open: boolean) {
  return `${open ? "▾" : "▸"} ${name}`
}

export function providerRowDescription(count: number) {
  return count === 1 ? "1 model" : `${count} models`
}

export function providerOfValue(value: string) {
  const index = value.indexOf("/")
  return index > 0 ? value.slice(0, index) : undefined
}
