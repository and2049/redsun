import z from "zod"
import { test, expect, describe } from "bun:test"
import { ProjectTool, applyFixFlag, formatActionResult } from "../../src/tool/project"

describe("project tool definition", () => {
  test("tool id is project", () => {
    expect(ProjectTool.id).toBe("project")
  })

  test("init returns description and parameters", async () => {
    const init = await ProjectTool.init()
    expect(init.description).toContain("TIER-1")
    expect(init.description).toContain("check")
    expect(init.description).toContain("lint")
    expect(init.description).toContain("test")
    expect(init.parameters).toBeDefined()
  })

  test("action is enum with all actions", async () => {
    const init = await ProjectTool.init()
    const schema = init.parameters as z.ZodObject<any>
    for (const action of ["check", "test", "build", "lint", "typecheck", "format"]) {
      const result = schema.safeParse({ action })
      expect(result.success).toBe(true)
    }
    const bad = schema.safeParse({ action: "invalid" })
    expect(bad.success).toBe(false)
  })

  test("optional parameters are optional", async () => {
    const init = await ProjectTool.init()
    const schema = init.parameters as z.ZodObject<any>
    const result = schema.safeParse({ action: "test" })
    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
  })
})

describe("applyFixFlag", () => {
  test("biome — adds --write --unsafe when not already present", () => {
    expect(applyFixFlag("bunx biome check .")).toBe("bunx biome check --write --unsafe .")
  })

  test("biome — preserves existing --write", () => {
    expect(applyFixFlag("bunx biome check --write --unsafe .")).toBe("bunx biome check --write --unsafe .")
  })

  test("eslint — appends --fix", () => {
    expect(applyFixFlag("npx eslint .")).toBe("npx eslint . --fix")
  })

  test("oxlint — appends --fix", () => {
    expect(applyFixFlag("bunx oxlint .")).toBe("bunx oxlint . --fix")
  })

  test("ruff check — inserts --fix", () => {
    expect(applyFixFlag("uv run ruff check .")).toBe("uv run ruff check --fix .")
  })

  test("ruff format — removes --check", () => {
    expect(applyFixFlag("ruff format --check .")).toBe("ruff format .")
  })

  test("clippy — appends --fix --allow-dirty", () => {
    expect(applyFixFlag("cargo clippy")).toBe("cargo clippy --fix --allow-dirty")
  })

  test("cargo fmt — removes --check", () => {
    expect(applyFixFlag("cargo fmt --check")).toBe("cargo fmt")
  })

  test("prettier — replaces --check with --write", () => {
    expect(applyFixFlag("bunx prettier --check .")).toBe("bunx prettier --write .")
  })

  test("prettier — preserves existing --write", () => {
    expect(applyFixFlag("bunx prettier --write .")).toBe("bunx prettier --write .")
  })

  test("golangci-lint — appends --fix", () => {
    expect(applyFixFlag("golangci-lint run")).toBe("golangci-lint run --fix")
  })

  test("rubocop — appends -a", () => {
    expect(applyFixFlag("bundle exec rubocop")).toBe("bundle exec rubocop -a")
  })

  test("unknown command passes through unchanged", () => {
    expect(applyFixFlag("make test")).toBe("make test")
    expect(applyFixFlag("ctest")).toBe("ctest")
    expect(applyFixFlag("custom-tool --some-flag")).toBe("custom-tool --some-flag")
  })
})

describe("formatActionResult", () => {
  const passResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false }
  const failResult = { stdout: "", stderr: "error: test failed", exitCode: 1, timedOut: false }
  const timedOutResult = { stdout: "", stderr: "", exitCode: 0, timedOut: true }

  test("exit 0 with no output — ✓ name", () => {
    expect(formatActionResult("test", passResult)).toBe("✓ test")
  })

  test("exit 0 with warnings — ✓ name (N warnings)", () => {
    const result = { stdout: "Found 3 warnings\nline1\nline2\nline3\nline4\nline5\nline6", stderr: "", exitCode: 0, timedOut: false }
    const formatted = formatActionResult("lint", result)
    expect(formatted).toContain("✓ lint (3 warnings)")
  })

  test("exit 0 with errors — ✓ name (N errors)", () => {
    const result = { stdout: "Found 2 errors\nline1", stderr: "", exitCode: 0, timedOut: false }
    const formatted = formatActionResult("typecheck", result)
    expect(formatted).toContain("✓ typecheck (2 errors)")
  })

  test("non-zero exit — ✗ name with first 10 lines", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `error line ${i + 1}`)
    const result = { stdout: "", stderr: lines.join("\n"), exitCode: 1, timedOut: false }
    const formatted = formatActionResult("lint", result)
    expect(formatted).toContain("✗ lint")
    expect(formatted.split("\n").length).toBeLessThanOrEqual(11) // 1 header + 10 lines
  })

  test("timeout — ✗ name (timed out)", () => {
    expect(formatActionResult("test", timedOutResult)).toBe("✗ test (timed out)")
  })
})
