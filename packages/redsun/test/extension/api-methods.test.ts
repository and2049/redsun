import { test, expect, describe } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import { ExtensionRunner } from "../../src/extension/runner"
import { ExtensionContext } from "../../src/extension/context"
import { Entry } from "../../src/entry/entry"
import { SessionStatus } from "../../src/session/status"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"
import type { Extension } from "../../src/extension/types"

const sessionID = (name: string) => `ses_${name}_${Math.random().toString(36).slice(2)}`

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
        const sid = sessionID("sm")
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        runner.currentContext = ExtensionContext.create({
          mode: "rpc",
          cwd: "/tmp",
          sessionID: sid,
          agent: "test",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const api = createAPI(runner)

        SessionStatus.set(sid, { type: "busy" })
        api.sendMessage("hello world")
        await Bun.sleep(100)

        const entries = await Entry.list(sid)
        const msgs = entries.filter((e) => (e as any).customType === "extension.message")
        expect(msgs.length).toBe(1)
        expect((msgs[0] as any).content).toBe("hello world")
        expect((msgs[0] as any).display).toBe(true)
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

        const model = await Provider.defaultModel()
        const result = await api.setModel(`${model.providerID}/${model.modelID}`)
        expect(result).toBe(true)

        const override = ToolRegistry.consumeModelOverride("ses_model_1")
        expect(override).toEqual({ providerID: model.providerID, modelID: model.modelID })

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

  test("explicit prompt model wins and leaves input hook override for the next prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const explicit = { providerID: "explicit", modelID: "explicit-model" }
        const override = await Provider.defaultModel()
        const session = await Session.create({})
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        const api = createAPI(runner)
        ExtensionRunner.on<Extension.InputEvent>(runner, "input", async () => {
          await api.setModel(`${override.providerID}/${override.modelID}`)
          return undefined
        })

        const explicitMessage = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: explicit,
          noReply: true,
          parts: [{ type: "text", text: "use override" }],
        })
        expect((explicitMessage.info as any).model).toEqual(explicit)

        runner.handlers.set("input", [])
        const overrideMessage = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "use stored override" }],
        })
        expect((overrideMessage.info as any).model).toEqual({ providerID: override.providerID, modelID: override.modelID })

        expect(ToolRegistry.consumeModelOverride(session.id)).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })

  test("input hook model override wins shell model when no explicit model is supplied", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const override = await Provider.defaultModel()
        const session = await Session.create({})
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        const api = createAPI(runner)
        ExtensionRunner.on<Extension.InputEvent>(runner, "input", async () => {
          await api.setModel(`${override.providerID}/${override.modelID}`)
          return undefined
        })

        await SessionPrompt.shell({
          sessionID: session.id,
          agent: "build",
          command: "echo override",
        })

        const messages = await Session.messages({ sessionID: session.id })
        const user = messages.find((msg) => msg.info.role === "user")
        const assistant = messages.find((msg) => msg.info.role === "assistant")
        expect((user?.info as any).model).toEqual({ providerID: override.providerID, modelID: override.modelID })
        expect((assistant?.info as any).providerID).toBe(override.providerID)
        expect((assistant?.info as any).modelID).toBe(override.modelID)

        await Session.remove(session.id)
      },
    })
  })
})

describe("input event", () => {
  test("input handler can return handled action", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.InputEvent>(runner, "input", () => ({
      action: "handled",
    }))
    const result = await ExtensionRunner.emit<Extension.InputEvent>(runner, {
      type: "input",
      text: "hello",
    })
    expect((result as Extension.InputEventResult)?.action).toBe("handled")
  })

  test("input handler can return transform action with text", async () => {
    const runner = makeRunner()
    ExtensionRunner.on<Extension.InputEvent>(runner, "input", () => ({
      action: "transform",
      text: "rewritten input",
    }))
    const result = await ExtensionRunner.emit<Extension.InputEvent>(runner, {
      type: "input",
      text: "original",
    })
    expect((result as Extension.InputEventResult)?.action).toBe("transform")
    expect((result as Extension.InputEventResult)?.text).toBe("rewritten input")
  })
})
