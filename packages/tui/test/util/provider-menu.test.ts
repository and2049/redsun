import { expect, test } from "bun:test"
import {
  groupByProvider,
  providerOfValue,
  providerRowDescription,
  providerRowTitle,
} from "../../src/util/provider-menu"

test("groups by provider in first-seen order", () => {
  // The caller has already sorted; grouping must not resort behind its back.
  const groups = groupByProvider(
    [
      { id: "sonnet", provider: "anthropic" },
      { id: "gpt", provider: "openai" },
      { id: "haiku", provider: "anthropic" },
    ],
    (item) => item.provider,
  )
  expect([...groups.keys()]).toEqual(["anthropic", "openai"])
  expect(groups.get("anthropic")?.map((item) => item.id)).toEqual(["sonnet", "haiku"])
})

test("the chevron reports whether the provider is open", () => {
  expect(providerRowTitle("Anthropic", false)).toBe("▸ Anthropic")
  expect(providerRowTitle("Anthropic", true)).toBe("▾ Anthropic")
})

test("the row says how many models it is hiding", () => {
  expect(providerRowDescription(1)).toBe("1 model")
  expect(providerRowDescription(7)).toBe("7 models")
})

test("only the first slash separates the provider from the model", () => {
  expect(providerOfValue("anthropic/claude-sonnet-4")).toBe("anthropic")
  // Model ids carry slashes of their own; splitting on the last one would name
  // a provider that does not exist.
  expect(providerOfValue("openrouter/meta-llama/llama-3-70b")).toBe("openrouter")
  // The worker-model form's "use the configured default" is not a model.
  expect(providerOfValue("__clear__")).toBeUndefined()
  expect(providerOfValue("/leading")).toBeUndefined()
})
