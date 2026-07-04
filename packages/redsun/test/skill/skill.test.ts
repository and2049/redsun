import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

function normalize(p: string): string {
  return p.replace(/\\/g, "/")
}

test("discovers skills from .redsun/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".redsun", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = (await Skill.all()).find((item) => item.name === "test-skill")
      expect(skill).toBeDefined()
      expect(skill?.description).toBe("A test skill for verification.")
      expect(normalize(skill?.location ?? "")).toContain("skill/test-skill/SKILL.md")
      expect(skill?.baseDir).toBeTruthy()
      expect(skill?.scope).toBe("project")
      expect(skill?.disableModelInvocation).toBe(false)
    },
  })
})

test("discovers multiple skills from .redsun/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".redsun", "skill", "my-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: my-skill
description: Another test skill.
---

# My Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = (await Skill.all()).filter((item) => item.scope === "project")
      expect(skills.length).toBe(1)
      expect(skills[0].name).toBe("my-skill")
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".redsun", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = (await Skill.all()).filter((item) => item.scope === "project")
      expect(skills).toEqual([])
    },
  })
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = (await Skill.all()).filter((item) => item.scope === "project")
      expect(skills).toEqual([])
    },
  })
})

test("parses disable-model-invocation frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".redsun", "skill", "hidden-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: hidden-skill
description: A hidden skill that should not appear in the system prompt.
disable-model-invocation: true
---

# Hidden Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = (await Skill.all()).find((item) => item.name === "hidden-skill")
      expect(skill).toBeDefined()
      expect(skill?.disableModelInvocation).toBe(true)
    },
  })
})

test("Skill.formatForPrompt hides disable-model-invocation skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const visible = path.join(dir, ".redsun", "skill", "visible-skill")
      await Bun.write(
        path.join(visible, "SKILL.md"),
        `---
name: visible-skill
description: A skill that should be visible in the system prompt.
---

# Visible
`,
      )
      const hidden = path.join(dir, ".redsun", "skill", "hidden-skill")
      await Bun.write(
        path.join(hidden, "SKILL.md"),
        `---
name: hidden-skill
description: A skill that should NOT be visible.
disable-model-invocation: true
---

# Hidden
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Skill.formatForPrompt()
      expect(prompt).toContain("visible-skill")
      expect(prompt).not.toContain("hidden-skill")
      expect(prompt).toContain("<available_skills>")
    },
  })
})

test("Skill.formatForPrompt returns empty string when no visible skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const hidden = path.join(dir, ".redsun", "skill", "hidden-skill")
      await Bun.write(
        path.join(hidden, "SKILL.md"),
        `---
name: hidden-skill
description: Only hidden skill.
disable-model-invocation: true
---

# Hidden
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prompt = await Skill.formatForPrompt()
      expect(prompt).not.toContain("hidden-skill")
    },
  })
})

test("SystemPrompt.skills returns formatted skills XML", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".redsun", "skill", "demo-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: demo-skill
description: Demo skill for system prompt injection.
---

# Demo
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skillsPrompt = await SystemPrompt.skills()
      expect(skillsPrompt).toContain("demo-skill")
      expect(skillsPrompt).toContain("<available_skills>")
    },
  })
})

test("accepts extra skill paths from resources_discover", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const externalDir = path.join(dir, "external-skills", "ext-skill")
      await Bun.write(
        path.join(externalDir, "SKILL.md"),
        `---
name: ext-skill
description: Skill from an external path.
---

# External
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { ToolRegistry } = await import("../../src/tool/registry")
      const externalPath = path.join(tmp.path, "external-skills", "ext-skill", "SKILL.md")
      const runner = await ToolRegistry.getRunner()
      runner.discoveredResources.skillPaths = [externalPath]
      const found = await Skill.get("ext-skill")
      expect(found).toBeTruthy()
      expect(found?.name).toBe("ext-skill")
      expect(found?.description).toBe("Skill from an external path.")
    },
  })
})

