export function orderedToolEntries<T>(tools: Record<string, T>): Array<[string, T]> {
  return Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))
}
