import { test, expect, describe } from "bun:test"
import { ExtensionRunner } from "../../src/extension/runner"
import { ExtensionWrapper } from "../../src/extension/wrapper"
import { ExtensionContext } from "../../src/extension/context"
import type { Extension } from "../../src/extension/types"
import z from "zod"

function makeRunner() {
  return ExtensionRunner.create(() =>
    ExtensionContext.create({
      mode: "rpc",
      cwd: "/tmp",
      sessionID: "test",
      agent: "test",
      projectTrusted: true,
      getSystemPrompt: () => "",
    }),
  )
}

function makeContextFactory() {
  return () =>
    ExtensionContext.create({
      mode: "rpc",
      cwd: "/tmp",
      sessionID: "test",
      agent: "test",
      projectTrusted: true,
      getSystemPrompt: () => "",
    })
}

describe("ExtensionWrapper.wrapExecute", () => {
  const fakeTool: ExtensionWrapper.ResolvedTool = {
    id: "fake",
    description: "fake tool",
    parameters: z.object({ input: z.string() }),
    execute: async (args) => ({
      title: "ran",
      metadata: {},
      output: `out:${args.input}`,
    }),
  }

  test("passes through when no handlers are registered", async () => {
    const runner = makeRunner()
    const wrapped = ExtensionWrapper.wrapExecute(fakeTool, runner, { path: "", scope: "builtin" }, makeContextFactory())
    const result = await wrapped.execute({ input: "hi" }, {} as any)
    expect(result.output).toBe("out:hi")
  })

  test("blocks execution when tool_call returns block:true", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.ToolCallEvent>(runner, "tool_call", () => ({
      block: true,
      reason: "no",
    }))
    const wrapped = ExtensionWrapper.wrapExecute(fakeTool, runner, { path: "", scope: "builtin" }, makeContextFactory())
    await expect(wrapped.execute({ input: "hi" }, { callID: "1" } as any)).rejects.toThrow("no")
  })

  test("emits tool_result and applies output mutation", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.ToolResultEvent>(runner, "tool_result", () => ({
      output: "mutated",
      metadata: { extra: true },
    }))
    const wrapped = ExtensionWrapper.wrapExecute(fakeTool, runner, { path: "", scope: "builtin" }, makeContextFactory())
    const result = await wrapped.execute({ input: "hi" }, { callID: "1" } as any)
    expect(result.output).toBe("mutated")
    expect(result.metadata).toEqual({ extra: true })
  })
})
