import { test, expect, describe, mock, beforeAll } from "bun:test"
import { ExtensionContext } from "../../src/extension/context"
import { Entry } from "../../src/entry/entry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("ExtensionContext.getEntries", () => {
  test("returns empty array when no entries exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = ExtensionContext.create({
          mode: "rpc",
          cwd: tmp.path,
          sessionID: "ses_no_entries",
          agent: "",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const result = await ctx.getEntries("my-type")
        expect(result).toEqual([])
      },
    })
  })

  test("returns entries for a given customType", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Entry.append("ses_with", { type: "custom", customType: "my-type", data: { count: 42 } })
        await Entry.append("ses_with", { type: "custom", customType: "other-type", data: { count: 99 } })

        const ctx = ExtensionContext.create({
          mode: "rpc",
          cwd: tmp.path,
          sessionID: "ses_with",
          agent: "",
          projectTrusted: true,
          getSystemPrompt: () => "",
          getEntries: <T>(customType: string) => Entry.getByType<T>("ses_with", customType),
        })

        const result = await ctx.getEntries<{ count: number }>("my-type")
        expect(result.length).toBe(1)
        expect(result[0].data).toEqual({ count: 42 })
      },
    })
  })

  test("getEntries default returns empty array (when not provided)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = ExtensionContext.create({
          mode: "rpc",
          cwd: tmp.path,
          sessionID: "ses_default",
          agent: "",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })
        const result = await ctx.getEntries("any-type")
        expect(result).toEqual([])
      },
    })
  })
})

describe("ExtensionContext.forSession.getEntries", () => {
  test("forSession wires getEntries to Entry.getByType", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Entry.append("ses_session", { type: "custom", customType: "session-state", data: { step: 5 } })

        const ctx = ExtensionContext.forSession({
          mode: "rpc",
          sessionID: "ses_session",
          agent: "",
          projectTrusted: true,
          getSystemPrompt: () => "",
        })

        const result = await ctx.getEntries<{ step: number }>("session-state")
        expect(result.length).toBe(1)
        expect(result[0].data).toEqual({ step: 5 })
      },
    })
  })
})

describe("ExtensionContext.compact", () => {
  test("returns early when sessionID is empty", async () => {
    const ctx = ExtensionContext.create({
      mode: "rpc",
      cwd: "/tmp",
      sessionID: "",
      agent: "",
      projectTrusted: true,
      getSystemPrompt: () => "",
    })

    await expect(ctx.compact()).resolves.toBeUndefined()
  })
})

describe("ExtensionContext.compact error propagation (mocked)", () => {
  beforeAll(() => {
    mock.module("../../src/session/index", () => ({
      Session: {
        messages: async () => [{ info: { role: "user", model: { providerID: "openai", modelID: "gpt-4o" } } }],
      },
    }))
    mock.module("../../src/session/compaction", () => ({
      SessionCompaction: {
        create: async () => {
          throw new Error("compaction failed")
        },
      },
    }))
  })

  test("propagates error from SessionCompaction.create", async () => {
    const ctx = ExtensionContext.create({
      mode: "rpc",
      cwd: "/tmp",
      sessionID: "ses_compact_err",
      agent: "test",
      projectTrusted: true,
      getSystemPrompt: () => "",
    })

    await expect(ctx.compact()).rejects.toThrow("compaction failed")
  })
})
