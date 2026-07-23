import { describe, expect, test } from "bun:test"
import { needsWorkerModel, workerModelDisplay } from "../../src/component/dialog-worker-model"

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
          },
        },
      },
    ]

    expect(workerModelDisplay("opencode-go/deepseek-v4-flash", providers as never)).toEqual({
      model: "DeepSeek V4 Flash",
      provider: "OpenCode Go",
    })
    expect(workerModelDisplay("custom/model-id", [])).toEqual({
      model: "model-id",
      provider: "custom",
    })
  })
})
