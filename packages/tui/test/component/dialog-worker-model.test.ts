import { describe, expect, test } from "bun:test"
import {
  needsWorkerModel,
  workerModelDisplay,
  workerModelVariants,
  workerVariantDisplay,
} from "../../src/component/dialog-worker-model"

describe("compose worker model setup", () => {
  test("requires setup only for compose without a worker route", () => {
    expect(needsWorkerModel("compose", undefined)).toBe(true)
    expect(needsWorkerModel("compose", "openai/gpt-test")).toBe(false)
    expect(needsWorkerModel("build", undefined)).toBe(false)
  })

  test("uses provider and model display names for configured workers", () => {
    const providers = [
      {
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            variants: { high: {}, xhigh: {} },
          },
        },
      },
    ]
    const typed = providers as never

    expect(workerModelDisplay("opencode-go/deepseek-v4-flash", typed)).toEqual({
      model: "DeepSeek V4 Flash",
      provider: "OpenCode Go",
    })
    expect(workerModelDisplay("custom/model-id", [])).toEqual({
      model: "model-id",
      provider: "custom",
    })
    expect(workerModelVariants("opencode-go/deepseek-v4-flash", typed)).toEqual(["high", "xhigh"])
    expect(workerModelVariants("custom/model-id", typed)).toEqual([])
    expect(workerVariantDisplay("opencode-go/deepseek-v4-flash", "high", typed)).toBe("high")
    expect(workerVariantDisplay(undefined, "high", typed)).toBeUndefined()
    expect(workerVariantDisplay("opencode-go/deepseek-v4-flash", "default", typed)).toBeUndefined()
  })
})
