import { test, expect, describe, mock, beforeAll } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import { ExtensionRunner } from "../../src/extension/runner"
import { ExtensionContext } from "../../src/extension/context"
import { Entry } from "../../src/entry/entry"
import { SessionStatus } from "../../src/session/status"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { Extension } from "../../src/extension/types"

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

function createAPI(runner: ExtensionRunner.State, source?: Extension.SourceInfo): Extension.API {
  return ToolRegistry.createExtensionAPI(runner, source ?? { path: "/test", scope: "builtin" })
}

describe("sendMessage", () => {
  test("warns and returns early when no session context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = undefined
        const api = createAPI(runner)

        api.sendMessage("hello")
        await Bun.sleep(50)

        const entries = await Entry.list("test")
        expect(entries.filter((e) => (e as any).customType === "extension.message")).toEqual([])
      },
    })
  })

  test("appends a custom_message entry to the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = ExtensionContext.create({
          mode: "rpc",
          cwd: "/tmp",
          sessionID: "ses_sm_test",
          agent: "test",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const api = createAPI(runner)

        SessionStatus.set("ses_sm_test", { type: "busy" })
        api.sendMessage("hello world")
        await Bun.sleep(100)

        const entries = await Entry.list("ses_sm_test")
        const msgs = entries.filter((e) => (e as any).customType === "extension.message")
        expect(msgs.length).toBe(1)
        expect((msgs[0] as any).content).toBe("hello world")
        expect((msgs[0] as any).display).toBe(true)
      },
    })
  })
})

describe("sendMessage loop trigger (mocked)", () => {
  const loopSpy = mock(() => {})

  beforeAll(() => {
    mock.module("../../src/session/prompt", () => ({
      SessionPrompt: { loop: loopSpy, sendUserMessage: mock(() => {}) },
    }))
  })

  test("triggers loop when session is idle", async () => {
    loopSpy.mockClear()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = ExtensionContext.create({
          mode: "rpc",
          cwd: "/tmp",
          sessionID: "ses_idle_1",
          agent: "test",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const api = createAPI(runner)

        SessionStatus.set("ses_idle_1", { type: "idle" })
        api.sendMessage("trigger loop")
        await Bun.sleep(200)

        expect(loopSpy).toHaveBeenCalledWith("ses_idle_1")
      },
    })
  })

  test("does not trigger loop when session is busy", async () => {
    loopSpy.mockClear()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = ExtensionContext.create({
          mode: "rpc",
          cwd: "/tmp",
          sessionID: "ses_busy_1",
          agent: "test",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const api = createAPI(runner)

        SessionStatus.set("ses_busy_1", { type: "busy" })
        api.sendMessage("busy message")
        await Bun.sleep(200)

        expect(loopSpy).not.toHaveBeenCalled()
      },
    })
  })
})

describe("setModel", () => {
  test("returns false when no session context", async () => {
    const runner = makeRunner()
    runner.currentContext = undefined
    const api = createAPI(runner)
    const result = await api.setModel("openai/gpt-4o")
    expect(result).toBe(false)
  })

  test("consumeModelOverride returns undefined when no override", () => {
    expect(ToolRegistry.consumeModelOverride("unknown_session")).toBeUndefined()
  })
})

describe("setModel (mocked Provider)", () => {
  beforeAll(() => {
    mock.module("../../src/provider/provider", () => ({
      Provider: {
        parseModel: (model: string) => {
          const [providerID, modelID] = model.split("/")
          return { providerID, modelID }
        },
        getModel: async (providerID: string, _modelID: string) => {
          if (providerID === "nonexistent") throw new Error("ModelNotFoundError")
          return { id: _modelID }
        },
        defaultModel: async () => ({ providerID: "openai", modelID: "gpt-4o" }),
      },
    }))
  })

  test("returns true for valid model and stores override", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = ExtensionContext.create({
          mode: "rpc",
          cwd: "/tmp",
          sessionID: "ses_model_1",
          agent: "test",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const api = createAPI(runner)

        const result = await api.setModel("openai/gpt-4o")
        expect(result).toBe(true)

        const override = ToolRegistry.consumeModelOverride("ses_model_1")
        expect(override).toEqual({ providerID: "openai", modelID: "gpt-4o" })

        const second = ToolRegistry.consumeModelOverride("ses_model_1")
        expect(second).toBeUndefined()
      },
    })
  })

  test("returns false for invalid model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = ExtensionContext.create({
          mode: "rpc",
          cwd: "/tmp",
          sessionID: "ses_model_invalid",
          agent: "test",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const api = createAPI(runner)

        const result = await api.setModel("nonexistent/invalid-model")
        expect(result).toBe(false)

        const override = ToolRegistry.consumeModelOverride("ses_model_invalid")
        expect(override).toBeUndefined()
      },
    })
  })
})
