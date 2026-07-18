import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExtensionRuntime } from "../../src/extension/runtime"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("extension session commands", () => {
  test("creates and forks real sessions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "redsun-extension-session-"))
    dirs.push(directory)
    const extension = path.join(directory, "session.ts")
    const output = path.join(directory, "result.json")
    const calls: unknown[] = []
    await writeFile(
      extension,
      `export default (api) => {
        api.registerCommand({ name: "new", handler: async (_args, ctx) => Bun.write(${JSON.stringify(output)}, JSON.stringify(await ctx.newSession({ parentSession: "ses_parent" }))) })
        api.registerCommand({ name: "child", handler: async (_args, ctx) => Bun.write(${JSON.stringify(output)}, JSON.stringify(await ctx.newSession())) })
        api.registerCommand({ name: "fork", handler: async (_args, ctx) => Bun.write(${JSON.stringify(output)}, JSON.stringify(await ctx.fork("msg_target"))) })
        api.registerCommand({ name: "send", handler: () => {
          api.sendMessage("extension context")
          api.sendUserMessage("extension user")
        } })
        api.registerCommand({ name: "context", handler: async (_args, ctx) => {
          ctx.abort()
          await ctx.compact()
          await Bun.write(${JSON.stringify(output)}, JSON.stringify({ idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), system: ctx.getSystemPrompt(), usage: ctx.getContextUsage() }))
        } })
      }`,
    )
    const plugin = {
      directory,
      worktree: directory,
      project: {},
      client: {
        session: {
          create: async (input: unknown) => {
            calls.push(["create", input])
            return { data: { id: "ses_created" } }
          },
          fork: async (input: unknown) => {
            calls.push(["fork", input])
            return { data: { id: "ses_forked" } }
          },
          abort: async (input: unknown) => {
            calls.push(["abort", input])
            return { data: true }
          },
          messages: async (input: unknown) => {
            calls.push(["messages", input])
            return {
              data: [
                {
                  info: {
                    role: "user",
                    model: { providerID: "openai", modelID: "gpt-test" },
                  },
                  parts: [],
                },
              ],
            }
          },
          summarize: async (input: unknown) => {
            calls.push(["summarize", input])
            return { data: true }
          },
          promptAsync: async (input: unknown) => {
            calls.push(["promptAsync", input])
            return { data: undefined }
          },
        },
      },
    } as unknown as PluginInput
    const runtime = await ExtensionRuntime.create({
      plugin,
      userEntries: [extension],
      projectEntries: [],
      defaultTrust: "never",
    })

    expect(await ExtensionRuntime.runCommand(directory, "new", "", "ses_active", "build")).toBe(true)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ sessionID: "ses_created" })
    expect(await ExtensionRuntime.runCommand(directory, "child", "", "ses_active", "build")).toBe(true)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ sessionID: "ses_created" })
    expect(await ExtensionRuntime.runCommand(directory, "fork", "", "ses_active", "build")).toBe(true)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ sessionID: "ses_forked" })
    expect(calls).toEqual([
      ["create", { body: { parentID: "ses_parent" } }],
      ["create", { body: { parentID: "ses_active" } }],
      ["fork", { path: { id: "ses_active" }, body: { messageID: "msg_target" } }],
    ])

    await runtime.hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_active", model: { limit: { context: 100 } } as never },
      { system: ["stable system"] },
    )
    await runtime.hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID: "ses_active",
            tokens: { input: 20, output: 5, reasoning: 5, cache: { read: 0, write: 0 } },
          },
        },
      } as never,
    })
    await runtime.hooks.event?.({
      event: { type: "session.status", properties: { sessionID: "ses_active", status: { type: "busy" } } },
    })
    expect(await ExtensionRuntime.runCommand(directory, "context", "", "ses_active", "build")).toBe(true)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      idle: false,
      pending: true,
      system: "stable system",
      usage: { tokens: 30, contextWindow: 100, percent: 30 },
    })
    expect(calls.slice(-3)).toEqual([
      ["abort", { path: { id: "ses_active" } }],
      ["messages", { path: { id: "ses_active" }, query: { limit: 10 } }],
      [
        "summarize",
        {
          path: { id: "ses_active" },
          body: { providerID: "openai", modelID: "gpt-test" },
        },
      ],
    ])
    await runtime.hooks.event?.({
      event: { type: "session.status", properties: { sessionID: "ses_active", status: { type: "idle" } } },
    })
    expect(await ExtensionRuntime.runCommand(directory, "context", "", "ses_active", "build")).toBe(true)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      idle: true,
      pending: false,
      system: "stable system",
      usage: { tokens: 30, contextWindow: 100, percent: 30 },
    })
    expect(await ExtensionRuntime.runCommand(directory, "send", "", "ses_active", "build")).toBe(true)
    for (let index = 0; index < 20 && calls.filter((call) => Array.isArray(call) && call[0] === "promptAsync").length < 2; index++) {
      await Bun.sleep(10)
    }
    expect(calls.filter((call) => Array.isArray(call) && call[0] === "promptAsync")).toEqual([
      [
        "promptAsync",
        {
          path: { id: "ses_active" },
          body: { agent: "build", parts: [{ type: "text", text: "extension user" }] },
        },
      ],
      [
        "promptAsync",
        {
          path: { id: "ses_active" },
          body: { agent: "build", parts: [{ type: "text", text: "Continue.", synthetic: true }] },
        },
      ],
    ])
    expect(await ExtensionRuntime.customMessages("ses_active")).toContain("extension context")
    await runtime.hooks.dispose?.()
  })
})
