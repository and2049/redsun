import { test, expect, describe } from "bun:test"
import { ExtensionRunner } from "../../src/extension/runner"
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

describe("ExtensionRunner", () => {

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

  test("resources_discover collects skillPaths and promptPaths from handlers", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.ResourcesDiscoverEvent>(runner, "resources_discover", () => ({
      skillPaths: ["/a/skills", "/b/skills"],
      promptPaths: ["/a/prompts"],
    }))
    ExtensionRunner.on<Extension.ResourcesDiscoverEvent>(runner, "resources_discover", () => ({
      promptPaths: ["/c/prompts"],
    }))
    await ExtensionRunner.emit<Extension.ResourcesDiscoverEvent>(runner, {
      type: "resources_discover",
      cwd: "/work",
      reason: "startup",
    })
    expect(runner.discoveredResources.skillPaths).toEqual(["/a/skills", "/b/skills"])
    expect(runner.discoveredResources.promptPaths).toEqual(["/a/prompts", "/c/prompts"])
  })

  test("resources_discover result is deduped across handlers", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.ResourcesDiscoverEvent>(runner, "resources_discover", () => ({
      skillPaths: ["/shared/skills"],
    }))
    ExtensionRunner.on<Extension.ResourcesDiscoverEvent>(runner, "resources_discover", () => ({
      skillPaths: ["/shared/skills", "/other/skills"],
    }))
    await ExtensionRunner.emit<Extension.ResourcesDiscoverEvent>(runner, {
      type: "resources_discover",
      cwd: "/work",
      reason: "startup",
    })
    expect(runner.discoveredResources.skillPaths).toEqual(["/shared/skills", "/other/skills"])
  })

  test("registered tools do not implicitly restrict active tools", async () => {
    const runner = makeRunner()
    await ExtensionRunner.registerTool(runner, {
      id: "custom_tool",
      init: async () => ({
        description: "custom",
        parameters: z.object({}),
        execute: async () => ({ title: "ok", output: "ok", metadata: {} }),
      }),
    } as any)

    expect(ExtensionRunner.getActiveTools(runner)).toEqual([])
    expect(ExtensionRunner.isToolActive(runner, "builtin")).toBe(true)
    ExtensionRunner.setActiveTools(runner, ["custom_tool"])
    expect(ExtensionRunner.getActiveTools(runner)).toEqual(["custom_tool"])
    expect(ExtensionRunner.isToolActive(runner, "custom_tool")).toBe(true)
    expect(ExtensionRunner.isToolActive(runner, "mcp_search")).toBe(false)
  })

  test("agents_register collects agentPaths from handlers", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.AgentsRegisterEvent>(runner, "agents_register", () => ({
      agentPaths: ["/a/scout.md", "/a/architect.md"],
    }))
    ExtensionRunner.on<Extension.AgentsRegisterEvent>(runner, "agents_register", () => ({
      agentPaths: ["/b/reviewer.md"],
    }))
    await ExtensionRunner.emit<Extension.AgentsRegisterEvent>(runner, {
      type: "agents_register",
      cwd: "/work",
      reason: "startup",
    })
    expect(runner.discoveredResources.agentPaths).toEqual([
      "/a/scout.md",
      "/a/architect.md",
      "/b/reviewer.md",
    ])
  })

  test("agents_register result is deduped across handlers", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.AgentsRegisterEvent>(runner, "agents_register", () => ({
      agentPaths: ["/shared/agent.md"],
    }))
    ExtensionRunner.on<Extension.AgentsRegisterEvent>(runner, "agents_register", () => ({
      agentPaths: ["/shared/agent.md", "/other/agent.md"],
    }))
    await ExtensionRunner.emit<Extension.AgentsRegisterEvent>(runner, {
      type: "agents_register",
      cwd: "/work",
      reason: "startup",
    })
    expect(runner.discoveredResources.agentPaths).toEqual(["/shared/agent.md", "/other/agent.md"])
  })

  test("session_before_compact cancel is returned when any handler cancels", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.SessionBeforeCompactEvent>(runner, "session_before_compact", () => ({
      cancel: true,
    }))
    const result = await ExtensionRunner.emit<Extension.SessionBeforeCompactEvent>(runner, {
      type: "session_before_compact",
      sessionID: "s1",
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ cancel: true })
  })

  test("session_before_compact does not cancel when no handler returns cancel", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.SessionBeforeCompactEvent>(runner, "session_before_compact", () => ({}))
    const result = await ExtensionRunner.emit<Extension.SessionBeforeCompactEvent>(runner, {
      type: "session_before_compact",
      sessionID: "s1",
      signal: new AbortController().signal,
    })
    expect((result as Extension.SessionBeforeCompactResult | undefined)?.cancel).toBeUndefined()
  })

  test("session_before_switch cancel is returned when handler cancels", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.SessionBeforeSwitchEvent>(runner, "session_before_switch", () => ({
      cancel: true,
    }))
    const result = await ExtensionRunner.emit<Extension.SessionBeforeSwitchEvent>(runner, {
      type: "session_before_switch",
      reason: "new",
    })
    expect(result).toEqual({ cancel: true })
  })

  test("session_before_switch does not cancel when no handler cancels", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.SessionBeforeSwitchEvent>(runner, "session_before_switch", () => ({}))
    const result = await ExtensionRunner.emit<Extension.SessionBeforeSwitchEvent>(runner, {
      type: "session_before_switch",
      reason: "new",
    })
    expect((result as Extension.SessionBeforeSwitchResult | undefined)?.cancel).toBeUndefined()
  })

  test("session_before_fork handler is called during emit", async () => {
    const runner = makeRunner()
    let called = false
    ExtensionRunner.on<Extension.SessionBeforeForkEvent>(runner, "session_before_fork", () => {
      called = true
    })
    await ExtensionRunner.emit<Extension.SessionBeforeForkEvent>(runner, {
      type: "session_before_fork",
      entryId: "msg1",
      position: "at",
    })
    expect(called).toBe(true)
  })
})

describe("ExtensionRunner provider queue", () => {
  const providerConfig: Extension.ProviderConfig = {
    baseUrl: "https://api.example.com/v1",
    models: [{ id: "my-model", name: "My Model", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  }

  test("registerProvider queues when registrar not wired", () => {
    const runner = makeRunner()
    ExtensionRunner.registerProvider(runner, "p1", providerConfig, "/src/p1.ts")
    expect(runner.pendingProviderRegistrations.length).toBe(1)
    expect(runner.pendingProviderRegistrations[0].name).toBe("p1")
    expect(runner.pendingProviderRegistrations[0].config).toEqual(providerConfig)
    expect(runner.pendingProviderRegistrations[0].source).toBe("/src/p1.ts")
  })

  test("registerProvider calls registrar directly when wired", () => {
    const runner = makeRunner()
    const registered: Array<{ name: string; config: Extension.ProviderConfig }> = []
    runner.providerRegistrar = {
      register: (name, config) => { registered.push({ name, config }) },
      unregister: () => {},
    }
    ExtensionRunner.registerProvider(runner, "p2", providerConfig, "/src/p2.ts")
    expect(registered.length).toBe(1)
    expect(registered[0].name).toBe("p2")
    expect(registered[0].config).toEqual(providerConfig)
    expect(runner.pendingProviderRegistrations.length).toBe(0)
  })

  test("unregisterProvider calls unregister when wired", () => {
    const runner = makeRunner()
    const unregistered: string[] = []
    runner.providerRegistrar = {
      register: () => {},
      unregister: (name) => { unregistered.push(name) },
    }
    ExtensionRunner.unregisterProvider(runner, "p1")
    expect(unregistered).toEqual(["p1"])
  })

  test("unregisterProvider filters pending when registrar not wired", () => {
    const runner = makeRunner()
    runner.pendingProviderRegistrations = [
      { name: "p1", config: providerConfig, source: "" },
      { name: "p2", config: providerConfig, source: "" },
      { name: "p3", config: providerConfig, source: "" },
    ]
    ExtensionRunner.unregisterProvider(runner, "p2")
    expect(runner.pendingProviderRegistrations.length).toBe(2)
    expect(runner.pendingProviderRegistrations.map((r) => r.name)).toEqual(["p1", "p3"])
  })

  test("flushProviderRegistrations processes all and clears array", async () => {
    const runner = makeRunner()
    const registered: Array<{ name: string; config: Extension.ProviderConfig }> = []
    runner.providerRegistrar = {
      register: (name, config) => { registered.push({ name, config }) },
      unregister: () => {},
    }
    runner.pendingProviderRegistrations = [
      { name: "p1", config: providerConfig, source: "" },
      { name: "p2", config: providerConfig, source: "" },
      { name: "p3", config: providerConfig, source: "" },
    ]
    await ExtensionRunner.flushProviderRegistrations(runner)
    expect(registered.length).toBe(3)
    expect(registered.map((r) => r.name)).toEqual(["p1", "p2", "p3"])
    expect(runner.pendingProviderRegistrations.length).toBe(0)
  })

  test("unregisterAllProviders removes every runner-owned provider", async () => {
    const runner = makeRunner()
    const unregistered: string[] = []
    runner.providerRegistrar = {
      register: () => {},
      unregister: (name) => { unregistered.push(name) },
    }
    ExtensionRunner.registerProvider(runner, "p1", providerConfig, "/src/p1.ts")
    ExtensionRunner.registerProvider(runner, "p2", providerConfig, "/src/p2.ts")

    await ExtensionRunner.unregisterAllProviders(runner)

    expect(unregistered).toEqual(["p1", "p2"])
    expect(runner.registeredProviders.size).toBe(0)
    expect(runner.pendingProviderRegistrations).toEqual([])
  })
})
