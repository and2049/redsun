import { describe, expect, test } from "bun:test"
import {
  canonicalToolName,
  finiteNumber,
  flattenTodos,
  primitiveInputSummary,
  todoItems,
  toolDisplayMetadata,
  webSearchProviderLabel,
} from "../../src/util/tool-display"

test("normalizes shared tool primitives", () => {
  expect(["bash", "task", "apply_patch", "plugin_tool"].map(canonicalToolName)).toEqual([
    "shell",
    "subagent",
    "patch",
    "plugin_tool",
  ])
  expect([finiteNumber(-1.5), finiteNumber(Number.NaN), finiteNumber("1")]).toEqual([-1.5, undefined, undefined])
  expect(primitiveInputSummary({ command: "pwd", count: 2, nested: {} })).toBe("[command=pwd, count=2]")
  expect(primitiveInputSummary({ path: "src/a.ts", line: 2 }, ["path"])).toBe("[line=2]")
})

describe("todoItems", () => {
  test("keeps nested children and drops malformed entries", () => {
    const parent = { content: "auth", status: "in_progress", children: [{ content: "login", status: "completed" }, 1] }
    expect(todoItems([parent, { content: 2 }, null, { content: "docs", status: "pending" }])).toEqual([
      { content: "auth", status: "in_progress", children: [{ content: "login", status: "completed", children: [] }] },
      { content: "docs", status: "pending", children: [] },
    ])
    expect(todoItems({ todos: [] })).toEqual([])
  })

  test("flattens parents before their children in list order", () => {
    const todos = todoItems([
      { content: "a", status: "completed", children: [{ content: "a1", status: "completed" }] },
      { content: "b", status: "pending" },
    ])
    expect(flattenTodos(todos).map((todo) => todo.content)).toEqual(["a", "a1", "b"])
  })
})

describe("webSearchProviderLabel", () => {
  test("labels known providers", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Web Search via Parallel")
    expect(webSearchProviderLabel("exa")).toBe("Web Search via Exa")
    expect(webSearchProviderLabel("firecrawl")).toBe("Web Search via Firecrawl")
    expect(webSearchProviderLabel("tavily")).toBe("Web Search via Tavily")
  })

  test("labels providers dynamically", () => {
    expect(webSearchProviderLabel("other")).toBe("Web Search via Other")
  })

  for (const [name, provider] of [
    ["undefined", undefined],
    ["null", null],
    ["an object", {}],
    ["an array", []],
    ["a number", 1],
    ["an empty string", ""],
  ] as const) {
    test(`uses the generic label for ${name}`, () => {
      expect(webSearchProviderLabel(provider)).toBe("Web Search")
    })
  }
})

describe("toolDisplayMetadata", () => {
  test("returns tool metadata for non-pending states", () => {
    const metadata = { provider: "parallel", numResults: 3 }

    expect(toolDisplayMetadata({ status: "running", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "completed", metadata })).toBe(metadata)
    expect(toolDisplayMetadata({ status: "error", metadata })).toBe(metadata)
  })

  test("does not expose pending or malformed metadata", () => {
    expect(toolDisplayMetadata({ status: "streaming", metadata: { provider: "exa" } })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed" })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: null })).toEqual({})
    expect(toolDisplayMetadata({ status: "completed", metadata: [] })).toEqual({})
    expect(toolDisplayMetadata(undefined)).toEqual({})
  })
})
