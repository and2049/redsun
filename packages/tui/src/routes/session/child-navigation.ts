type Sibling = {
  readonly id: string
  readonly parentID?: string
}

export function childSessions<T extends Sibling>(family: readonly T[]): T[] {
  return family.filter((info) => !!info.parentID).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function nextChild<T extends Sibling>(
  children: readonly T[],
  currentID: string | undefined,
  direction: number,
): T | undefined {
  if (children.length < 2) return undefined
  const current = children.findIndex((info) => info.id === currentID)
  if (current < 0) return undefined
  return children[(current + direction + children.length) % children.length]
}
