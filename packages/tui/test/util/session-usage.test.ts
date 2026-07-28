import { describe, expect, test } from "bun:test"
import type { Message, Provider } from "@opencode-ai/sdk/v2"
import { fitSessionUsage, sessionUsage, type SessionUsage } from "../../src/util/session-usage"

function assistant(input: {
  id: string
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}) {
  return {
    id: input.id,
    sessionID: "session",
    role: "assistant",
    providerID: "provider",
    modelID: "model",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: input.tokens,
    time: { created: 0, completed: 1 },
  } as unknown as Message
}

const provider = {
  id: "provider",
  name: "Provider",
  source: "custom",
  env: [],
  options: {},
  models: {
    model: {
      id: "model",
      providerID: "provider",
      name: "Model",
      family: "model",
      api: { id: "model", url: "", npm: "" },
      capabilities: {},
      cost: {},
      limit: { context: 1000, output: 1000 },
      options: {},
      headers: {},
      status: "active",
    },
  },
} as unknown as Provider

describe("sessionUsage", () => {
  test("calculates current context, cumulative cache rate, and cost", () => {
    const usage = sessionUsage({
      messages: [
        assistant({
          id: "first",
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        assistant({
          id: "last",
          tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 300, write: 100 } },
        }),
      ],
      providers: [provider],
      cost: 1.25,
    })

    expect(usage).toEqual({
      context: "515 (52%)",
      percent: "52%",
      cache: "cache 50%",
      cost: "$1.25",
    })
  })

  test("handles missing cache, cost, and context limit", () => {
    const withoutLimit = {
      ...provider,
      models: {
        model: {
          ...provider.models.model,
          limit: { context: 0, output: 1000 },
        },
      },
    } as Provider
    const usage = sessionUsage({
      messages: [
        assistant({
          id: "last",
          tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 0, write: 0 } },
        }),
      ],
      providers: [withoutLimit],
      cost: 0,
    })

    expect(usage).toEqual({
      context: "115",
      percent: undefined,
      cache: undefined,
      cost: undefined,
    })
  })
})

describe("fitSessionUsage", () => {
  const usage: SessionUsage = {
    context: "36.3K (4%)",
    percent: "4%",
    cache: "cache 78%",
    cost: "$0.93",
  }

  test("shortens fields in priority order", () => {
    const full = "36.3K (4%) · cache 78% · $0.93"
    const compact = "4% · cache 78% · $0.93"
    const noCost = "4% · cache 78%"

    expect(fitSessionUsage(usage, full.length)).toBe(full)
    expect(fitSessionUsage(usage, full.length - 1)).toBe(compact)
    expect(fitSessionUsage(usage, compact.length - 1)).toBe(noCost)
    expect(fitSessionUsage(usage, noCost.length - 1)).toBe("4%")
    expect(fitSessionUsage(usage, 1)).toBeUndefined()
  })

  test("keeps the available context value when optional fields are absent", () => {
    expect(fitSessionUsage({ context: "900" }, 3)).toBe("900")
    expect(fitSessionUsage({ context: "900" }, 2)).toBeUndefined()
  })
})
