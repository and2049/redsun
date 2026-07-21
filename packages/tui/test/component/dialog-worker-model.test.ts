import { describe, expect, test } from "bun:test"
import { needsWorkerModel } from "../../src/component/dialog-worker-model"

describe("compose worker model setup", () => {
  test("requires setup only for compose without a worker route", () => {
    expect(needsWorkerModel("compose", undefined)).toBe(true)
    expect(needsWorkerModel("compose", "openai/gpt-test")).toBe(false)
    expect(needsWorkerModel("build", undefined)).toBe(false)
  })
})
