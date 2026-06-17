import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("SessionCompaction.process guards", () => {
  test("returns 'stop' when parent message is not found", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id

        const userMsg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID,
          type: "text",
          text: "Hello",
        })

        const messages = await Session.messages({ sessionID })

        const result = await SessionCompaction.process({
          parentID: "msg_nonexistent",
          messages,
          sessionID,
          abort: new AbortController().signal,
          auto: false,
        })

        expect(result).toBe("stop")

        await Session.remove(sessionID)
      },
    })
  })
})

describe("compaction promptText logic", () => {
  const defaultPrompt =
    "Provide a detailed prompt for continuing our conversation above."

  function computePromptText(compactResult: { prompt?: string; context?: string[] } | undefined): string {
    return compactResult?.prompt ?? [defaultPrompt, ...(compactResult?.context ?? [])].join("\n\n")
  }

  test("falls back to default when no extension result", () => {
    expect(computePromptText(undefined)).toBe(defaultPrompt)
  })

  test("uses extension prompt when provided", () => {
    expect(computePromptText({ prompt: "Custom prompt from extension" })).toBe("Custom prompt from extension")
  })

  test("joins context with default when no prompt but context provided", () => {
    expect(computePromptText({ context: ["Context A", "Context B"] })).toBe(
      defaultPrompt + "\n\nContext A\n\nContext B",
    )
  })

  test("prompt takes precedence over context", () => {
    expect(computePromptText({ prompt: "P", context: ["C"] })).toBe("P")
  })
})
