type Sibling = {
  readonly id: string
  readonly parentID?: string
}

export const ACTIVE_LIST_ROWS = 3

export function childSessions<T extends Sibling>(family: readonly T[]): T[] {
  return family.filter((info) => !!info.parentID).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function activeChildren<T extends Sibling>(children: readonly T[], status: (id: string) => string): T[] {
  return children.filter((info) => status(info.id) === "running")
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

export function nextInActiveList<T extends Sibling>(
  active: readonly T[],
  rootID: string,
  currentID: string | undefined,
  direction: number,
): string | undefined {
  const index = active.findIndex((info) => info.id === currentID)
  const target = index + direction
  if (target < 0) return currentID === rootID ? undefined : rootID
  if (target >= active.length) return undefined
  return active[target]?.id
}

export function listWindow(selected: number, total: number, size: number = ACTIVE_LIST_ROWS) {
  const start = Math.max(0, Math.min(selected - size + 1, total - size))
  return { start, end: Math.min(total, start + size) }
}
