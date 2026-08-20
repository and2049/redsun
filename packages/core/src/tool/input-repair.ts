export * as ToolInputRepair from "./input-repair.js"

/**
 * REDSUN: repair malformed tool-call arguments before rejecting the call (ported from
 * v1's tool-repair.ts). Some models send array/object arguments double-encoded as JSON
 * strings, or use the legacy single-edit shape where a schema expects `edits[]`.
 *
 * Returns a repaired copy of the input, or undefined when nothing could be repaired
 * (the caller then falls back to its normal invalid-input handling).
 */

type JsonSchemaLike = { readonly properties?: Record<string, unknown> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function repair(value: unknown, schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const properties = isRecord(schema) ? ((schema as JsonSchemaLike).properties ?? {}) : {}
  if (!isRecord(properties)) return undefined

  const input: Record<string, unknown> = { ...value }
  let changed = false

  // A top-level property whose schema type is array/object but whose value arrived as
  // a string is parsed in place.
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string") continue
    const property = properties[key]
    if (!isRecord(property)) continue
    const type = property.type
    const wanted = Array.isArray(type) ? type : [type]
    if (!wanted.includes("array") && !wanted.includes("object")) continue
    try {
      const inner = JSON.parse(item)
      if (inner && typeof inner === "object") {
        input[key] = inner
        changed = true
      }
    } catch {
      // not double-encoded JSON; leave for normal validation
    }
  }

  // Legacy fold: a schema expecting `edits[]` (multiedit) given top-level
  // oldString/newString becomes a single-entry edits array.
  const editsProperty = properties["edits"]
  if (
    isRecord(editsProperty) &&
    editsProperty.type === "array" &&
    input.edits === undefined &&
    typeof input.oldString === "string" &&
    typeof input.newString === "string"
  ) {
    input.edits = [
      {
        oldString: input.oldString,
        newString: input.newString,
        ...(typeof input.replaceAll === "boolean" ? { replaceAll: input.replaceAll } : {}),
      },
    ]
    delete input.oldString
    delete input.newString
    delete input.replaceAll
    changed = true
  }

  return changed ? input : undefined
}
