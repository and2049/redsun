import { test, expect, describe } from "bun:test"
import { PromptTemplate } from "../../src/prompt/template"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

describe("PromptTemplate.substitute", () => {
  test("substitutes named {{argName}} placeholders", () => {
    const out = PromptTemplate.substitute("Hello {{name}}!", "world", { name: "World" })
    expect(out).toBe("Hello World!")
  })

  test("falls back to defaults from frontmatter argDefs", () => {
    const out = PromptTemplate.substitute(
      "Branch: {{branch}}",
      "",
      {},
      [{ name: "branch", default: "main" }],
    )
    expect(out).toBe("Branch: main")
  })

  test("uses positional arguments when no named match", () => {
    const out = PromptTemplate.substitute(
      "first={{a}} second={{b}}",
      "one two",
      {},
      [{ name: "a" }, { name: "b" }],
    )
    expect(out).toBe("first=one second=two")
  })

  test("substitutes $ARGUMENTS for full raw args", () => {
    const out = PromptTemplate.substitute("Args: $ARGUMENTS", "one two three", {})
    expect(out).toBe("Args: one two three")
  })

  test("substitutes $@ for full raw args", () => {
    const out = PromptTemplate.substitute("Args: $@", "a b c", {})
    expect(out).toBe("Args: a b c")
  })

  test("substitutes $1, $2 positional args", () => {
    const out = PromptTemplate.substitute("First: $1, Second: $2", "alpha beta", {})
    expect(out).toBe("First: alpha, Second: beta")
  })

  test("missing positional arg becomes empty string", () => {
    const out = PromptTemplate.substitute("X=$1 Y=$2", "only", {})
    expect(out).toBe("X=only Y=")
  })

  test("named arg overrides default when present", () => {
    const out = PromptTemplate.substitute(
      "branch={{branch}}",
      "",
      { branch: "feature" },
      [{ name: "branch", default: "main" }],
    )
    expect(out).toBe("branch=feature")
  })

  test("ignores unknown named placeholders silently (no default)", () => {
    const out = PromptTemplate.substitute("X={{unknown}}", "y", {})
    expect(out).toBe("X=")
  })

  test("substitutes all placeholders in a single pass without recursion", () => {
    const out = PromptTemplate.substitute(
      "value={{a}} then $a",
      "",
      { a: "alpha" },
    )
    expect(out).toBe("value=alpha then $a")
  })
})

describe("PromptTemplate.discovery", () => {
  test("discovers templates from .redsun/prompts/ directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".redsun", "prompts", "pr.md"),
          `---
name: pr
description: Generate a pull request description
arguments:
  - name: branch
    description: Target branch
    default: main
---
Write a PR description for changes against {{branch}}.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const templates = await PromptTemplate.all()
        expect(templates.length).toBe(1)
        expect(templates[0].name).toBe("pr")
        expect(templates[0].description).toBe("Generate a pull request description")
        expect(templates[0].arguments?.length).toBe(1)
        expect(templates[0].arguments?.[0].name).toBe("branch")
        expect(templates[0].arguments?.[0].default).toBe("main")
        expect(templates[0].content).toContain("{{branch}}")
        expect(templates[0].scope).toBe("project")
      },
    })
  })

  test("uses filename as name when frontmatter is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".redsun", "prompts", "greet.md"),
          `Just say hi to the user.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const t = await PromptTemplate.get("greet")
        expect(t).toBeTruthy()
        expect(t?.name).toBe("greet")
        expect(t?.content).toContain("Just say hi to the user.")
      },
    })
  })

  test("uses frontmatter name over filename when provided", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".redsun", "prompts", "filename.md"),
          `---
name: override
description: Overridden name
---
Body.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const t = await PromptTemplate.get("override")
        expect(t).toBeTruthy()
        expect(t?.name).toBe("override")
      },
    })
  })

  test("falls back to filename-as-name when frontmatter is empty", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".redsun", "prompts", "empty-frontmatter.md"),
          `---\n---\nbody\n`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const t = await PromptTemplate.get("empty-frontmatter")
        expect(t).toBeTruthy()
        expect(t?.name).toBe("empty-frontmatter")
      },
    })
  })

  test("accepts extra prompt paths from resources_discover", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const external = path.join(dir, "shared", "shared-template.md")
        await Bun.write(
          external,
          `---
name: shared
description: A shared template
---
Shared body.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { ToolRegistry } = await import("../../src/tool/registry")
        const external = path.join(tmp.path, "shared", "shared-template.md")
        const runner = await ToolRegistry.getRunner()
        runner.discoveredResources.promptPaths = [external]
        const t = await PromptTemplate.get("shared")
        expect(t).toBeTruthy()
        expect(t?.content).toBe("Shared body.")
      },
    })
  })
})

describe("PromptTemplate end-to-end substitution", () => {
  test("named argument substitution with positional fallback", () => {
    const out = PromptTemplate.substitute(
      "Compare {{branch}} with {{base}}",
      "main develop",
      {},
      [
        { name: "branch" },
        { name: "base", default: "origin/main" },
      ],
    )
    expect(out).toBe("Compare main with develop")
  })

  test("default is used when positional is missing", () => {
    const out = PromptTemplate.substitute(
      "Target: {{branch}}",
      "feature",
      {},
      [
        { name: "branch" },
        { name: "base", default: "origin/main" },
      ],
    )
    expect(out).toBe("Target: feature")
  })
})
