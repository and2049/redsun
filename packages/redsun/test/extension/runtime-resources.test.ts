import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigAgent } from "../../src/config/agent"
import { ConfigCommand } from "../../src/config/command"
import { ExtensionRuntime } from "../../src/extension/runtime"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("extension resources", () => {
  test("aggregates and loads contributed prompt and agent paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "redsun-extension-resources-"))
    dirs.push(directory)
    const prompt = path.join(directory, "review-extra.md")
    const agent = path.join(directory, "scout.md")
    const extension = path.join(directory, "resources.ts")
    await writeFile(prompt, "---\ndescription: Extra review\n---\nReview $ARGUMENTS")
    await writeFile(agent, "---\ndescription: Scout files\nmode: subagent\n---\nInspect the project.")
    await writeFile(
      extension,
      `export default (api) => {
        api.on("resources_discover", () => ({ promptPaths: [${JSON.stringify(prompt)}] }))
        api.on("resources_discover", () => ({ skillPaths: ["skill-a"], promptPaths: [${JSON.stringify(prompt)}] }))
        api.on("agents_register", () => ({ agentPaths: [${JSON.stringify(agent)}] }))
        api.on("agents_register", () => ({ agentPaths: [${JSON.stringify(agent)}, "agent-b"] }))
      }`,
    )
    const runtime = await ExtensionRuntime.create({
      plugin: { directory, worktree: directory, project: {} } as unknown as PluginInput,
      userEntries: [extension],
      projectEntries: [],
      defaultTrust: "never",
    })

    expect(ExtensionRuntime.resourcesFor(directory)).toEqual({
      skillPaths: ["skill-a"],
      promptPaths: [prompt],
      themePaths: [],
      agentPaths: [agent, "agent-b"],
    })
    expect(await ConfigCommand.loadPaths([prompt])).toEqual({
      "review-extra": { description: "Extra review", template: "Review $ARGUMENTS" },
    })
    expect(await ConfigAgent.loadPaths([agent])).toMatchObject({
      scout: { description: "Scout files", mode: "subagent", prompt: "Inspect the project." },
    })
    await runtime.hooks.dispose?.()
  })
})
