import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { repairToolInput } from "../../src/session/llm/tool-repair"

const editSchema: JSONSchema7 = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
      },
    },
  },
}

describe("repairToolInput", () => {
  test("parses a JSON-string array argument in place", () => {
    const raw = JSON.stringify({
      filePath: "a.ts",
      edits: JSON.stringify([{ oldString: "a", newString: "b" }]),
    })
    const repaired = repairToolInput(raw, editSchema)
    expect(repaired).toBeDefined()
    expect(JSON.parse(repaired!)).toEqual({
      filePath: "a.ts",
      edits: [{ oldString: "a", newString: "b" }],
    })
  })

  test("folds legacy top-level oldString/newString into edits[]", () => {
    const raw = JSON.stringify({ filePath: "a.ts", oldString: "a", newString: "b", replaceAll: true })
    const repaired = repairToolInput(raw, editSchema)
    expect(repaired).toBeDefined()
    expect(JSON.parse(repaired!)).toEqual({
      filePath: "a.ts",
      edits: [{ oldString: "a", newString: "b", replaceAll: true }],
    })
  })

  test("leaves string properties whose schema type is string untouched", () => {
    const raw = JSON.stringify({ filePath: '["not","an","array"]' })
    expect(repairToolInput(raw, editSchema)).toBeUndefined()
  })

  test("returns undefined when nothing changed", () => {
    const raw = JSON.stringify({ filePath: "a.ts", edits: [{ oldString: "a", newString: "b" }] })
    expect(repairToolInput(raw, editSchema)).toBeUndefined()
  })

  test("returns undefined for unparseable input", () => {
    expect(repairToolInput("{not json", editSchema)).toBeUndefined()
  })

  test("returns undefined when the string is not valid JSON for the array property", () => {
    const raw = JSON.stringify({ filePath: "a.ts", edits: "definitely not json" })
    expect(repairToolInput(raw, editSchema)).toBeUndefined()
  })

  test("tolerates a missing schema", () => {
    const raw = JSON.stringify({ filePath: "a.ts", edits: "[]" })
    expect(repairToolInput(raw, undefined)).toBeUndefined()
  })
})
