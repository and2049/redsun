// REDSUN: moving between a session and its subagents.
//
// Upstream reaches subagents through a picker panel above the prompt. Redsun
// navigates into the child session itself, so these are the two moves that
// replace it: down from the parent enters the first child, left and right cycle
// siblings, and up returns to the parent.

type Sibling = {
  readonly id: string
  readonly parentID?: string
}

/**
 * The children of the family, in a stable order.
 *
 * `family` resolves from the family root, so it is the same list whether the
 * route sits on the parent or on one of its children. IDs sort chronologically,
 * which puts siblings in the order they were spawned.
 */
export function childSessions<T extends Sibling>(family: readonly T[]): T[] {
  return family.filter((info) => !!info.parentID).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The sibling `direction` steps away from `currentID`, wrapping at both ends.
 *
 * Returns undefined when there is nowhere to go: fewer than two siblings, or a
 * current session that is not one of them (the parent, say, where left and
 * right mean nothing).
 */
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
