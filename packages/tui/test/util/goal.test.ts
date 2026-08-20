import { describe, expect, test } from "bun:test"
import { formatGoalBudget, parseGoalArgs } from "../../src/util/goal"

describe("parseGoalArgs", () => {
  test("a bare condition has no budget", () => {
    expect(parseGoalArgs("all tests pass")).toEqual({ condition: "all tests pass" })
  })

  test("an empty input is a clear", () => {
    expect(parseGoalArgs("")).toEqual({ condition: "" })
    expect(parseGoalArgs("   ")).toEqual({ condition: "" })
  })

  test("token suffixes scale and bare integers are raw counts", () => {
    expect(parseGoalArgs("--tokens 200k fix it")).toEqual({ condition: "fix it", budget: { tokens: 200_000 } })
    expect(parseGoalArgs("--tokens 1.5m fix it")).toEqual({ condition: "fix it", budget: { tokens: 1_500_000 } })
    expect(parseGoalArgs("--tokens 500 fix it")).toEqual({ condition: "fix it", budget: { tokens: 500 } })
    expect(parseGoalArgs("--tokens 2K fix it")).toEqual({ condition: "fix it", budget: { tokens: 2_000 } })
  })

  test("time requires a unit and supports s, m, h, and decimals", () => {
    expect(parseGoalArgs("--time 30m ship")).toEqual({ condition: "ship", budget: { wallClockMs: 1_800_000 } })
    expect(parseGoalArgs("--time 2h ship")).toEqual({ condition: "ship", budget: { wallClockMs: 7_200_000 } })
    expect(parseGoalArgs("--time 1.5h ship")).toEqual({ condition: "ship", budget: { wallClockMs: 5_400_000 } })
    expect(parseGoalArgs("--time 45s ship")).toEqual({ condition: "ship", budget: { wallClockMs: 45_000 } })
    expect(parseGoalArgs("--time 0s ship")).toEqual({ condition: "ship", budget: { wallClockMs: 0 } })
    expect(parseGoalArgs("--time 30 ship").error).toContain("invalid --time value")
  })

  test("both flags combine, in either order, with = syntax too", () => {
    const expected = { condition: "done when green", budget: { tokens: 200_000, wallClockMs: 1_800_000 } }
    expect(parseGoalArgs("--tokens 200k --time 30m done when green")).toEqual(expected)
    expect(parseGoalArgs("--time 30m --tokens 200k done when green")).toEqual(expected)
    expect(parseGoalArgs("--tokens=200k --time=30m done when green")).toEqual(expected)
  })

  test("the condition is kept verbatim, including interior dashes", () => {
    expect(parseGoalArgs("--tokens 1k run x --flag and pass")).toEqual({
      condition: "run x --flag and pass",
      budget: { tokens: 1_000 },
    })
  })

  test("errors: unknown, duplicate, missing, and malformed flags", () => {
    expect(parseGoalArgs("--budget 5 fix").error).toContain("unknown flag: --budget")
    expect(parseGoalArgs("--tokens 1k --tokens 2k fix").error).toContain("duplicate flag: --tokens")
    expect(parseGoalArgs("--tokens").error).toContain("missing value for --tokens")
    expect(parseGoalArgs("--tokens abc fix").error).toContain("invalid --tokens value")
    expect(parseGoalArgs("--tokens 1.5 fix").error).toContain("invalid --tokens value")
    // A flag whose value got swallowed by the condition start errors instead of misparsing.
    expect(parseGoalArgs("--tokens fix the bug").error).toContain("invalid --tokens value")
  })
})

describe("formatGoalBudget", () => {
  test("round-trips the short forms", () => {
    expect(formatGoalBudget({ tokens: 200_000, wallClockMs: 1_800_000 })).toBe("200k tokens · 30m")
    expect(formatGoalBudget({ tokens: 1_500_000 })).toBe("1.5m tokens")
    expect(formatGoalBudget({ wallClockMs: 0 })).toBe("0s")
    expect(formatGoalBudget({ tokens: 500 })).toBe("500 tokens")
  })
})
