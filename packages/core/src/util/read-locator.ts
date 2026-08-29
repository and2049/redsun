export * as ReadLocator from "./read-locator.js"

export const READ_TOOLS: ReadonlySet<string> = new Set(["read"])

const PATH_KEYS = ["path", "filePath"]

export const path = (input: unknown) => {
  if (typeof input !== "object" || input === null) return
  const record = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
}

export const key = (name: string, input: unknown) => {
  if (!READ_TOOLS.has(name)) return
  const file = path(input)
  if (!file) return
  const record = input as Record<string, unknown>
  return JSON.stringify([file, record.offset ?? null, record.limit ?? null])
}

/** IDs of read results superseded by a later read of the same path and range, in call order. */
export const stale = (
  calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>,
) => {
  const latest = new Map<string, string>()
  for (const call of calls) {
    const locator = key(call.name, call.input)
    if (locator) latest.set(locator, call.id)
  }
  const current = new Set(latest.values())
  return new Set(calls.flatMap((call) => (key(call.name, call.input) && !current.has(call.id) ? [call.id] : [])))
}
