import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
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

describe("SessionCompaction auto trigger thresholds", () => {
  const model = {
    limit: { context: 100_000, output: 10_000 },
  } as any

  function tokens(input: number) {
    return {
      input,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
  }

  test("triggers before hard overflow at the default threshold", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionCompaction.resetAutoState()
        expect(SessionCompaction.tokenUsageRatio({ tokens: tokens(65_000), model })).toBeCloseTo(65_000 / 90_000)
        await expect(
          SessionCompaction.isOverflow({ sessionID: "threshold-default", tokens: tokens(65_000), model }),
        ).resolves.toBe(true)
      },
    })
  })

  test("uses configured trigger threshold", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            $schema: "https://redsun.sh/config.json",
            compaction: { triggerThreshold: 0.8, resetThreshold: 0.4 },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SessionCompaction.resetAutoState()
        await expect(
          SessionCompaction.isOverflow({ sessionID: "threshold-configured", tokens: tokens(65_000), model }),
        ).resolves.toBe(false)
        await expect(
          SessionCompaction.isOverflow({ sessionID: "threshold-configured", tokens: tokens(73_000), model }),
        ).resolves.toBe(true)
      },
    })
  })

  test("does not retrigger until usage drops below reset threshold", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = "threshold-hysteresis"
        SessionCompaction.resetAutoState(sessionID)
        await expect(SessionCompaction.isOverflow({ sessionID, tokens: tokens(65_000), model })).resolves.toBe(true)
        await expect(SessionCompaction.isOverflow({ sessionID, tokens: tokens(80_000), model })).resolves.toBe(false)
        await expect(SessionCompaction.isOverflow({ sessionID, tokens: tokens(30_000), model })).resolves.toBe(false)
        await expect(SessionCompaction.isOverflow({ sessionID, tokens: tokens(65_000), model })).resolves.toBe(true)
      },
    })
  })

  test("manual compaction creation ignores auto hysteresis state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sessionID = session.id
        SessionCompaction.resetAutoState(sessionID)
        await expect(SessionCompaction.isOverflow({ sessionID, tokens: tokens(65_000), model })).resolves.toBe(true)

        await SessionCompaction.create({
          sessionID,
          agent: "default",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          auto: false,
        })

        const messages = await Session.messages({ sessionID })
        const compactionPart = messages.flatMap((message) => message.parts).find((part) => part.type === "compaction")
        expect(compactionPart).toMatchObject({ type: "compaction", auto: false })

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

test("pre-sampling overflow creates a compaction boundary before continuing", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          compaction: { strategy: "algorithmic" },
          provider: {
            "context-test": {
              npm: "@ai-sdk/openai-compatible",
              api: "http://127.0.0.1:1/v1",
              options: { apiKey: "test" },
              models: {
                tiny: { limit: { context: 100, output: 10 } },
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const user = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "context-test", modelID: "tiny" },
        summary: { title: "seed", diffs: [] },
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: user.id,
        sessionID: session.id,
        type: "text",
        text: "x".repeat(2_000),
      })

      const unsubscribe = Bus.subscribe(SessionCompaction.Event.Compacted, (event) => {
        if (event.properties.sessionID === session.id) SessionPrompt.cancel(session.id)
      })
      await SessionPrompt.loop(session.id)
      unsubscribe()

      const all = await Session.messages({ sessionID: session.id })
      expect(all.flatMap((message) => message.parts).find((part) => part.type === "compaction")).toMatchObject({
        type: "compaction",
        auto: true,
        overflow: true,
      })
      const compacted = await MessageV2.filterCompacted(MessageV2.stream(session.id))
      expect(compacted.some((message) => message.info.id === user.id)).toBe(false)
      expect(
        compacted.some(
          (message) => message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic),
        ),
      ).toBe(true)

      await Session.remove(session.id)
    },
  })
})
