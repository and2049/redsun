import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// Every string in here is shipped to a model verbatim. Upstream owns these files
// and rewords them often, so a merge can silently reintroduce OpenCode's identity,
// its documentation URLs, or its config paths -- a user following a path spelled
// `.opencode/` finds nothing. This suite fails the merge instead of the user.
//
// Deliberate upstream references are still allowed: redsun keeps OpenCode's config
// schema and plugin API, so pointing at the upstream docs is correct. What is not
// allowed is presenting upstream's *identity* or upstream's *paths* as this
// product's own.

const SYSTEM_PROMPTS = path.join(import.meta.dir, "../../src/plugin/system-prompt")
const RUNNER_PROMPTS = path.join(import.meta.dir, "../../src/session/runner/prompt")
const SKILLS = path.join(import.meta.dir, "../../src/plugin/skill")

const read = (directory: string, extension: string) =>
  fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .map((name) => ({ name, text: fs.readFileSync(path.join(directory, name), "utf8") }))

// Read from disk rather than from an import list: a prompt file upstream adds in
// the next merge is covered the moment it lands.
const prompts = [...read(SYSTEM_PROMPTS, ".txt"), ...read(RUNNER_PROMPTS, ".txt")]
const skills = read(SKILLS, ".md")

const IDENTITY = /\b(?:You are|powered by)\s+(?:opencode|OpenCode)\b/
const UPSTREAM_PATH = /opencode\.jsonc?|\.opencode\/|~\/\.config\/opencode|\.local\/share\/opencode/
const UPSTREAM_REPO = /github\.com\/anomalyco\/opencode/

// Upstream spellings belong in one place only: the translation table in the redsun
// skill, whose rows are markdown table lines. Anywhere else they read as this
// product's own paths.
const isTranslationRow = (line: string) => line.trimStart().startsWith("|")

const offending = (text: string, pattern: RegExp, allow: (line: string) => boolean = () => false) =>
  text
    .split("\n")
    .filter((line) => pattern.test(line) && !allow(line))
    .map((line) => line.trim())

describe("model-facing branding", () => {
  test("prompt files exist and were discovered", () => {
    expect(prompts.length).toBeGreaterThanOrEqual(6)
    expect(skills.map((item) => item.name).sort()).toEqual(["opencode.md", "report.md"])
  })

  test.each(prompts.map((item) => [item.name, item.text] as const))(
    "%s does not introduce the agent as opencode",
    (_name, text) => {
      expect(offending(text, IDENTITY)).toEqual([])
    },
  )

  test.each(prompts.map((item) => [item.name, item.text] as const))(
    "%s does not name upstream config paths",
    (_name, text) => {
      expect(offending(text, UPSTREAM_PATH)).toEqual([])
    },
  )

  test.each(prompts.map((item) => [item.name, item.text] as const))(
    "%s routes feedback to redsun, not upstream",
    (_name, text) => {
      expect(offending(text, UPSTREAM_REPO)).toEqual([])
    },
  )

  test.each(skills.map((item) => [item.name, item.text] as const))(
    "%s does not introduce the agent as opencode",
    (_name, text) => {
      expect(offending(text, IDENTITY)).toEqual([])
    },
  )

  test.each(skills.map((item) => [item.name, item.text] as const))(
    "%s names upstream config paths only in the translation table",
    (_name, text) => {
      expect(offending(text, UPSTREAM_PATH, isTranslationRow)).toEqual([])
    },
  )

  test("only the report skill may point at the upstream issue tracker", () => {
    // report.md sends genuinely-upstream bugs to anomalyco/opencode on purpose.
    const skill = skills.find((item) => item.name === "opencode.md")!
    expect(offending(skill.text, UPSTREAM_REPO)).toEqual([])
  })

  test("the redsun issue tracker is the default in the report skill", () => {
    const report = skills.find((item) => item.name === "report.md")!
    expect(report.text).toContain("gh issue create --repo and2049/redsun")
  })
})
