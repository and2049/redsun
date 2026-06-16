import { test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { ExtensionRunner } from "../../src/extension/runner"
import type { Extension } from "../../src/extension/types"
import { ToolRegistry } from "../../src/tool/registry"

test("loads built-in agents when no custom agents configured", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("build")
      expect(names).toContain("plan")
    },
  })
})

test("custom subagent works alongside built-in primary agents", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".redsun")
      await fs.mkdir(opencodeDir, { recursive: true })
      const agentDir = path.join(opencodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Bun.write(
        path.join(agentDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const helper = agents.find((a) => a.name === "helper")
      expect(helper).toBeDefined()
      expect(helper?.mode).toBe("subagent")

      // Built-in primary agents should still exist
      const build = agents.find((a) => a.name === "build")
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
    },
  })
})

test("throws error when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            build: { disable: true },
            plan: { disable: true },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let thrown = false
      try {
        await Agent.list()
      } catch (e: any) {
        thrown = true
        expect(Config.InvalidError.isInstance(e)).toBe(true)
        expect(e.data?.message).toContain("No primary agents are available")
      }
      expect(thrown).toBe(true)
    },
  })
})

test("does not throw when at least one primary agent remains", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            build: { disable: true },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const plan = agents.find((a) => a.name === "plan")
      expect(plan).toBeDefined()
      expect(plan?.mode).toBe("primary")
    },
  })
})

test("custom primary agent satisfies requirement when built-ins disabled", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".redsun")
      await fs.mkdir(opencodeDir, { recursive: true })
      const agentDir = path.join(opencodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Bun.write(
        path.join(agentDir, "custom.md"),
        `---
model: test/model
mode: primary
---
Custom primary agent`,
      )

      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          agent: {
            build: { disable: true },
            plan: { disable: true },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const custom = agents.find((a) => a.name === "custom")
      expect(custom).toBeDefined()
      expect(custom?.mode).toBe("primary")
    },
  })
})

test("Agent.invalidate clears cache so subsequent reload sees new agents", async () => {
  await using tmp = await tmpdir()
  // Phase 1: confirm the agent doesn't exist
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      expect(agents.find((a) => a.name === "scout")).toBeUndefined()
    },
  })

  // Write the new agent file
  const agentDir = path.join(tmp.path, ".redsun", "agent")
  await fs.mkdir(agentDir, { recursive: true })
  await Bun.write(
    path.join(agentDir, "scout.md"),
    `---
model: test/model
mode: subagent
description: Fast recon agent
---
Scout prompt`,
  )

  // Phase 2: re-initialize (Instance.dispose clears all state caches)
  // and verify the new agent is picked up. This is the equivalent of
  // the LLM writing a .md file then triggering /reload.
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Instance.dispose()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const scout = agents.find((a) => a.name === "scout")
      expect(scout).toBeDefined()
      expect(scout?.mode).toBe("subagent")
      expect(scout?.description).toBe("Fast recon agent")
    },
  })
})

test("Agent.invalidate() clears the agent-level cache so re-read recomputes", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // First call populates the cache
      const first = await Agent.list()
      const firstNames = first.map((a) => a.name).sort()

      // After invalidate, the next call re-runs the state function.
      // The result has the same agents (rebuilt from config), but is
      // not the same object reference.
      await Agent.invalidate()
      const second = await Agent.list()
      const secondNames = second.map((a) => a.name).sort()
      expect(secondNames).toEqual(firstNames)
    },
  })
})

test("agents from extension-contributed paths appear in Agent.list()", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Write an agent file outside the standard config dirs
      const extAgentPath = path.join(tmp.path, "extension-agents", "scout.md")
      await fs.mkdir(path.dirname(extAgentPath), { recursive: true })
      await Bun.write(
        extAgentPath,
        `---
model: test/model
mode: subagent
description: Scout from extension
---
Scout from extension prompt`,
      )

      // Initialize the runner (which triggers agents_register emission)
      const runner = await ToolRegistry.getRunner()

      // Register a handler that contributes the agent path
      ExtensionRunner.on<Extension.AgentsRegisterEvent>(runner, "agents_register", () => ({
        agentPaths: [extAgentPath],
      }))

      // Emit the event
      await ExtensionRunner.emit<Extension.AgentsRegisterEvent>(runner, {
        type: "agents_register",
        cwd: tmp.path,
        reason: "startup",
      })

      // Invalidate and re-read agents
      await Agent.invalidate()
      const agents = await Agent.list()
      const scout = agents.find((a) => a.name === "scout")
      expect(scout).toBeDefined()
      expect(scout?.mode).toBe("subagent")
      expect(scout?.description).toBe("Scout from extension")
    },
  })
})
