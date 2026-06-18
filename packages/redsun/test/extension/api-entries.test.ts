import { test, expect, describe } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import { ExtensionRunner } from "../../src/extension/runner"
import { ExtensionContext } from "../../src/extension/context"
import { Entry } from "../../src/entry/entry"
import { Instance } from "../../src/project/instance"
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

function createAPI(runner: ExtensionRunner.State, source: Extension.SourceInfo): Extension.API {
  return ToolRegistry.createExtensionAPI(runner, source)
}

describe("Extension.API appendEntry", () => {
  test("writes a CustomEntry via Entry.append and returns an ent_ ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        const api = createAPI(runner, { path: "/test", scope: "builtin" })
        const sid = sessionID("api")

        const id = await api.appendEntry(sid, "my-extension", { count: 7 })
        expect(id).toStartWith("ent_")

        const entries = await Entry.list(sid)
        expect(entries.length).toBe(1)
        expect(entries[0].type).toBe("custom")
        expect((entries[0] as any).customType).toBe("my-extension")
        expect((entries[0] as any).data).toEqual({ count: 7 })
      },
    })
  })

  test("writes a CustomMessageEntry with explicit display and details", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        const api = createAPI(runner, { path: "/test", scope: "builtin" })
        const sid = sessionID("msg")

        const id = await api.appendCustomMessageEntry(
          sid,
          "my-extension",
          "Remember this fact",
          false,
          { source: "test" },
        )
        expect(id).toStartWith("ent_")

        const entries = await Entry.list(sid)
        expect(entries.length).toBe(1)
        expect(entries[0].type).toBe("custom_message")
        expect((entries[0] as any).customType).toBe("my-extension")
        expect((entries[0] as any).content).toBe("Remember this fact")
        expect((entries[0] as any).display).toBe(false)
        expect((entries[0] as any).details).toEqual({ source: "test" })
      },
    })
  })

  test("appendCustomMessageEntry defaults display to true when omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        const api = createAPI(runner, { path: "/test", scope: "builtin" })
        const sid = sessionID("msg_default")

        await api.appendCustomMessageEntry(sid, "ext", "no display arg")
        const entries = await Entry.list(sid)
        expect((entries[0] as any).display).toBe(true)
      },
    })
  })
})

describe("Extension.API used in extension factory", () => {
  test("extension can append entries on session_start and read them back via getEntries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.state()
        const runner = await ToolRegistry.getRunner()
        const api = createAPI(runner, { path: "/test", scope: "builtin" })
        const sid = sessionID("factory")

        let captured: Array<{ customType: string; data?: unknown }> = []
        api.on("session_start", async (_event, ctx) => {
          await api.appendEntry(ctx.sessionID, "test-extension", { step: 1 })
          await api.appendEntry(ctx.sessionID, "test-extension", { step: 2 })
          captured = await ctx.getEntries<{ step: number }>("test-extension")
        })

        const sessionCtx = ExtensionContext.forSession({
          mode: "rpc",
          sessionID: sid,
          agent: "",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        await ExtensionRunner.emit(runner, { type: "session_start", reason: "new" }, sessionCtx)

        expect(captured.length).toBe(2)
        expect(captured[0].data).toEqual({ step: 1 })
        expect(captured[1].data).toEqual({ step: 2 })
      },
    })
  })
})
