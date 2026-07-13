import { test, expect, describe } from "bun:test"
import { ExtensionRunner } from "../../src/extension/runner"
import { ExtensionWrapper, isProtectedPath } from "../../src/extension/wrapper"
import { ExtensionContext } from "../../src/extension/context"
import type { Extension } from "../../src/extension/types"
import z from "zod"
import path from "path"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

  test("emits tool_result with isError when execution fails", async () => {
    const runner = makeRunner()
    const events: Extension.ToolResultEvent[] = []
    ExtensionRunner.on<Extension.ToolResultEvent>(runner, "tool_result", (event) => {
      events.push(event)
    })
    const failing: ExtensionWrapper.ResolvedTool = {
      ...fakeTool,
      execute: async () => {
        throw new Error("tool failed")
      },
    }
    const wrapped = ExtensionWrapper.wrapExecute(failing, runner, { path: "", scope: "builtin" }, makeContextFactory())

    await expect(wrapped.execute({ input: "hi" }, { callID: "failure" } as any)).rejects.toThrow("tool failed")
    expect(events).toEqual([
      expect.objectContaining({ toolCallId: "failure", toolName: "fake", output: "tool failed", isError: true }),
    ])
  })

  test("blocks write tool for .env file", async () => {
    const runner = makeRunner()
    const writeTool: ExtensionWrapper.ResolvedTool = {
      id: "write",
      description: "write tool",
      parameters: z.object({ filePath: z.string(), content: z.string() }),
      execute: async (args) => ({ title: "written", metadata: {}, output: "ok" }),
    }
    const wrapped = ExtensionWrapper.wrapExecute(writeTool, runner, { path: "", scope: "builtin" }, makeContextFactory())
    await expect(wrapped.execute({ filePath: ".env", content: "x" }, { callID: "1" } as any)).rejects.toThrow("protected")
  })

  test("blocks edit tool for .git directory", async () => {
    const runner = makeRunner()
    const editTool: ExtensionWrapper.ResolvedTool = {
      id: "edit",
      description: "edit tool",
      parameters: z.object({ filePath: z.string() }),
      execute: async (args) => ({ title: "edited", metadata: {}, output: "ok" }),
    }
    const wrapped = ExtensionWrapper.wrapExecute(editTool, runner, { path: "", scope: "builtin" }, makeContextFactory())
    const gitPath = path.resolve("/tmp", ".git", "config")
    await expect(wrapped.execute({ filePath: gitPath }, { callID: "1" } as any)).rejects.toThrow("protected")
  })

  test("blocks write tool for node_modules", async () => {
    const runner = makeRunner()
    const writeTool: ExtensionWrapper.ResolvedTool = {
      id: "write",
      description: "write tool",
      parameters: z.object({ filePath: z.string(), content: z.string() }),
      execute: async (args) => ({ title: "written", metadata: {}, output: "ok" }),
    }
    const wrapped = ExtensionWrapper.wrapExecute(writeTool, runner, { path: "", scope: "builtin" }, makeContextFactory())
    const nmPath = path.resolve("/tmp", "node_modules", "foo", "index.js")
    await expect(wrapped.execute({ filePath: nmPath, content: "x" }, { callID: "1" } as any)).rejects.toThrow("protected")
  })

  test("blocks patch writes to protected paths before execution", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let executed = false
        const patchTool: ExtensionWrapper.ResolvedTool = {
          id: "patch",
          description: "patch tool",
          parameters: z.object({ patchText: z.string() }),
          execute: async () => {
            executed = true
            return { title: "patched", metadata: {}, output: "ok" }
          },
        }
        const wrapped = ExtensionWrapper.wrapExecute(patchTool, makeRunner(), { path: "", scope: "builtin" }, makeContextFactory())
        const patchText = "*** Begin Patch\n*** Add File: .git/config\n+blocked\n*** End Patch"

        await expect(wrapped.execute({ patchText }, { callID: "patch-protected" } as any)).rejects.toThrow("protected")
        expect(executed).toBe(false)
      },
    })
  })
})

describe("isProtectedPath", () => {
  test("blocks .env files", () => {
    expect(isProtectedPath(".env").blocked).toBe(true)
    expect(isProtectedPath(".env.local").blocked).toBe(true)
    expect(isProtectedPath(".env.production").blocked).toBe(true)
  })

  test("blocks .git directory paths", () => {
    const p = path.resolve("/tmp", ".git", "config")
    expect(isProtectedPath(p).blocked).toBe(true)
  })

  test("blocks node_modules directory paths", () => {
    const p = path.resolve("/tmp", "node_modules", "pkg", "index.js")
    expect(isProtectedPath(p).blocked).toBe(true)
  })

  test("blocks .redsun/extensions paths as extension writes", () => {
    const relative = isProtectedPath(path.join(".redsun", "extensions", "tool.ts"))
    expect(relative.blocked).toBe(true)
    expect(relative.type).toBe("extension")

    const nested = isProtectedPath(path.resolve("/tmp", "project", ".redsun", "extensions", "nested", "tool.ts"))
    expect(nested.blocked).toBe(true)
    expect(nested.type).toBe("extension")
  })

  test("allows normal paths", () => {
    expect(isProtectedPath("/tmp/foo.txt").blocked).toBe(false)
  })
})
