import { describe, expect, test } from "bun:test"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { AcpModels } from "../src/models.js"

// The shape Kiro 2.23.1 (KAS 0.66.8) reports after `session/new` and a model switch.
const KIRO: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "claude-opus-5.5",
    options: [
      { value: "auto", name: "Auto", _meta: { kiro: { thinkingToggleable: false } } },
      {
        value: "claude-opus-5.5",
        name: "Claude Opus 5.5",
        _meta: {
          kiro: {
            effortLevels: ["low", "medium", "high", "xhigh", "max"],
            defaultEffortLevel: "medium",
            thinkingToggleable: true,
          },
        },
      },
      {
        value: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        _meta: { kiro: { effortLevels: ["low", "medium", "high", "max"], defaultEffortLevel: "high" } },
      },
    ],
  },
  {
    id: "effortLevel",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value })),
  },
] as SessionConfigOption[]

describe("AcpModels", () => {
  test("reads each model's effort levels and default from Kiro's option metadata", () => {
    expect(AcpModels.fromConfig(KIRO)?.models).toEqual([
      { id: "auto", name: "Auto" },
      {
        id: "claude-opus-5.5",
        name: "Claude Opus 5.5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        efforts: ["low", "medium", "high", "max"],
        defaultEffort: "high",
      },
    ])
  })

  test("reads the session's effort selector, and none when the model has no levels", () => {
    expect(AcpModels.effort(KIRO)).toEqual({
      configId: "effortLevel",
      options: ["low", "medium", "high", "xhigh", "max"],
      current: "medium",
    })
    expect(AcpModels.effort(KIRO.slice(0, 1))).toBeUndefined()
  })
})
