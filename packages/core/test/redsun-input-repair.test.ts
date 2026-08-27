import { describe, expect, test } from "bun:test"
import { ToolInputRepair } from "@opencode-ai/core/tool/input-repair"
import { execute as executeToolRuntime } from "@opencode-ai/core/tool/runtime"
import { Effect, Schema } from "effect"

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    edits: { type: "array" },
    config: { type: "object" },
  },
}

describe("ToolInputRepair", () => {
  test("parses double-encoded array and object values in place", () => {
    const repaired = ToolInputRepair.repair(
      { path: "a.ts", edits: '[{"oldString":"a","newString":"b"}]', config: '{"deep":true}' },
      schema,
    )
    expect(repaired).toEqual({
      path: "a.ts",
      edits: [{ oldString: "a", newString: "b" }],
      config: { deep: true },
    })
  })

  test("folds the legacy single-edit shape into edits[]", () => {
    const repaired = ToolInputRepair.repair(
      { path: "a.ts", oldString: "a", newString: "b", replaceAll: true },
      schema,
    )
    expect(repaired).toEqual({ path: "a.ts", edits: [{ oldString: "a", newString: "b", replaceAll: true }] })
  })

  test("returns undefined when nothing is repairable", () => {
    expect(ToolInputRepair.repair({ path: "a.ts" }, schema)).toBeUndefined()
    expect(ToolInputRepair.repair({ path: "a.ts", edits: "not json" }, schema)).toBeUndefined()
    expect(ToolInputRepair.repair("just a string", schema)).toBeUndefined()
    // Schema-typed string values are never touched.
    expect(ToolInputRepair.repair({ path: '{"a":1}' }, schema)).toBeUndefined()
  })

  test("ToolRuntime.execute repairs on decode failure and keeps the original error otherwise", async () => {
    const tool = {
      name: "sample",
      description: "sample",
      input: Schema.Struct({
        items: Schema.Array(Schema.Struct({ value: Schema.String })),
      }),
      execute: (input: { items: readonly { value: string }[] }) =>
        Effect.succeed({ content: input.items.map((item) => item.value).join(",") }),
    }
    const repaired = await Effect.runPromise(
      executeToolRuntime(tool as never, { items: '[{"value":"a"},{"value":"b"}]' }, {} as never),
    )
    expect(repaired.content).toEqual([{ type: "text", text: "a,b" }])

    const failed = await Effect.runPromise(
      executeToolRuntime(tool as never, { items: "definitely not json" }, {} as never).pipe(Effect.exit),
    )
    expect(failed._tag).toBe("Failure")
    expect(String(failed)).toContain("Invalid arguments for tool")
  })
})
