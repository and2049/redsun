import { expect, test } from "bun:test"
import { parseWorkerModelRef, workerModelRef } from "../src/component/dialog-worker-model"

test("round-trips a worker model through the ref the backend parses", () => {
  const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }
  expect(workerModelRef(model)).toBe("anthropic/claude-sonnet-4#high")
  expect(parseWorkerModelRef(workerModelRef(model))).toEqual(model)
})

test("leaves the variant off when there is none", () => {
  expect(workerModelRef({ providerID: "openai", modelID: "gpt-5.5" })).toBe("openai/gpt-5.5")
  expect(parseWorkerModelRef("openai/gpt-5.5")).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
})

test("splits on the first slash, since model ids carry their own", () => {
  expect(parseWorkerModelRef("openrouter/meta-llama/llama-3-70b")).toEqual({
    providerID: "openrouter",
    modelID: "meta-llama/llama-3-70b",
  })
})

test("refuses anything that is not provider and model", () => {
  expect(parseWorkerModelRef("__clear__")).toBeUndefined()
  expect(parseWorkerModelRef("/leading")).toBeUndefined()
  expect(parseWorkerModelRef("anthropic/")).toBeUndefined()
})
