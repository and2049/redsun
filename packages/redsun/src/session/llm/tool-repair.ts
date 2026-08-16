import type { JSONSchema7 } from "@ai-sdk/provider"

/**
 * REDSUN: repair malformed tool-call arguments before rejecting the call
 * (ported from pi's prepareEditArguments; some models — e.g. Opus 4.6, GLM-5.1 —
 * send array/object arguments double-encoded as JSON strings, or use the legacy
 * single-edit shape for multiedit).
 *
 * Returns the repaired JSON input string, or undefined when nothing could be
 * repaired (the caller then falls back to its normal invalid-call handling).
 */
export function repairToolInput(rawInput: string, schema: JSONSchema7 | undefined): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawInput)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const input = parsed as Record<string, unknown>
  const properties =
    schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {}

  let changed = false

  // A top-level property whose schema type is array/object but whose value
  // arrived as a string is parsed in place.
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue
    const prop = properties[key as keyof typeof properties]
    if (!prop || typeof prop !== "object") continue
    const type = (prop as { type?: unknown }).type
    const wanted = Array.isArray(type) ? type : [type]
    if (!wanted.includes("array") && !wanted.includes("object")) continue
    try {
      const inner = JSON.parse(value)
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
  const editsProp = properties["edits" as keyof typeof properties]
  if (
    editsProp &&
    typeof editsProp === "object" &&
    (editsProp as { type?: unknown }).type === "array" &&
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

  return changed ? JSON.stringify(input) : undefined
}
