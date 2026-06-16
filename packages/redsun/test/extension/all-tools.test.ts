import { test, expect, describe } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { Tool } from "../../src/tool/tool"
import z from "zod"

function makeTool(id: string, description: string): Tool.Info {
  return {
    id,
    init: async () => ({
      description,
      parameters: z.object({}),
      execute: async () => ({ title: id, metadata: {}, output: description }),
    }),
  }
}

async function registeredToolIds(): Promise<string[]> {
  const tools = await ToolRegistry.all()
  return tools.map((t) => t.id)
}

async function registeredToolDescriptions(): Promise<Array<{ id: string; description: string }>> {
  const tools = await ToolRegistry.all()
  return await Promise.all(
    tools.map(async (t) => ({ id: t.id, description: (await t.init()).description })),
  )
}

describe("allTools deduplication", () => {
  test("custom tool overrides builtin with same ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        await ToolRegistry.register(makeTool("read", "custom file reader"))

        const descs = await registeredToolDescriptions()
        const readTools = descs.filter((d) => d.id === "read")
        expect(readTools.length).toBe(1)
        expect(readTools[0].description).toBe("custom file reader")
      },
    })
  })

  test("custom tool with unique ID appears alongside builtins", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        await ToolRegistry.register(makeTool("my-echo", "echo tool"))

        const ids = await registeredToolIds()
        expect(ids).toContain("my-echo")
        expect(ids).toContain("bash")
        expect(ids).toContain("read")
      },
    })
  })

  test("get() returns custom over builtin", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        await ToolRegistry.register(makeTool("write", "custom file writer"))

        const tool = await ToolRegistry.get("write")
        expect(tool).toBeDefined()
        const initialized = await tool!.init()
        expect(initialized.description).toBe("custom file writer")
      },
    })
  })

  test("list order: builtins first, then customs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        await ToolRegistry.register(makeTool("my-custom", "a custom tool"))

        const ids = await registeredToolIds()
        const bashIdx = ids.indexOf("bash")
        const customIdx = ids.indexOf("my-custom")
        expect(bashIdx).toBeGreaterThan(-1)
        expect(customIdx).toBeGreaterThan(-1)
        expect(bashIdx).toBeLessThan(customIdx)
      },
    })
  })
})
