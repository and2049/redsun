import { test, expect, describe } from "bun:test"
import { ExtensionRunner } from "../../src/extension/runner"
import { ExtensionContext } from "../../src/extension/context"
import type { Extension } from "../../src/extension/types"

describe("ExtensionRunner", () => {
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

  test("emit with no handlers returns undefined", async () => {
    const runner = makeRunner()
    const result = await ExtensionRunner.emit(runner, { type: "session_start", reason: "new" })
    expect(result).toBeUndefined()
  })

  test("emit calls registered handlers in order", async () => {
    const runner = makeRunner()
    const calls: string[] = []
    ExtensionRunner.on(runner, "session_start", () => {
      calls.push("first")
    })
    ExtensionRunner.on(runner, "session_start", () => {
      calls.push("second")
    })
    await ExtensionRunner.emit(runner, { type: "session_start", reason: "new" })
    expect(calls).toEqual(["first", "second"])
  })

  test("tool_call block is merged from first blocking handler", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.ToolCallEvent>(runner, "tool_call", () => ({
      block: true,
      reason: "denied",
    }))
    ExtensionRunner.on<Extension.ToolCallEvent>(runner, "tool_call", () => ({
      block: false,
    }))
    const result = await ExtensionRunner.emit<Extension.ToolCallEvent>(runner, {
      type: "tool_call",
      toolCallId: "1",
      toolName: "t",
      input: {},
    })
    expect(result).toEqual({ block: true, reason: "denied" })
  })

  test("tool_result output/metadata are merged from handlers", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.ToolResultEvent>(runner, "tool_result", () => ({
      output: "patched",
      metadata: { a: 1 },
      isError: false,
    }))
    const result = await ExtensionRunner.emit<Extension.ToolResultEvent>(runner, {
      type: "tool_result",
      toolCallId: "1",
      toolName: "t",
      input: {},
      output: "orig",
      metadata: {},
      isError: false,
    })
    expect(result).toEqual({ output: "patched", metadata: { a: 1 }, isError: false })
  })

  test("before_agent_start systemPrompt mutation is applied", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.BeforeAgentStartEvent>(runner, "before_agent_start", () => ({
      systemPrompt: "patched",
    }))
    const result = await ExtensionRunner.emit<Extension.BeforeAgentStartEvent>(runner, {
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "orig",
    })
    expect(result).toEqual({ systemPrompt: "patched" })
  })

  test("handler error does not crash emit", async () => {
    const runner = makeRunner()
    const calls: string[] = []
    ExtensionRunner.on(runner, "session_start", () => {
      throw new Error("boom")
    })
    ExtensionRunner.on(runner, "session_start", () => {
      calls.push("ok")
    })
    await ExtensionRunner.emit(runner, { type: "session_start", reason: "new" })
    expect(calls).toEqual(["ok"])
  })

  test("context override is used when provided", async () => {
    const runner = makeRunner()
    let receivedCwd = ""
    ExtensionRunner.on(runner, "session_start", (_e, ctx) => {
      receivedCwd = ctx.cwd
    })
    const override = ExtensionContext.create({
      mode: "rpc",
      cwd: "/override",
      sessionID: "x",
      agent: "x",
      projectTrusted: true,
      getSystemPrompt: () => "",
    })
    await ExtensionRunner.emit(runner, { type: "session_start", reason: "new" }, override)
    expect(receivedCwd).toBe("/override")
  })
})
