import { describe, expect, it } from "bun:test"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { RedsunWorkerModelTool } from "@opencode-ai/core/plugin/redsun/worker-model-tool"
import { definition } from "@opencode-ai/core/tool/runtime"

const model = (providerID: string, id: string, name: string) =>
  ({
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
    name,
  }) as Model.Info

describe("RedsunWorkerModelTool", () => {
  it("offers every available model as a picker option", () => {
    expect(
      RedsunWorkerModelTool.options([
        model("anthropic", "claude-sonnet-4", "Claude Sonnet 4"),
        model("claude-code", "sonnet", "Claude Sonnet"),
      ]),
    ).toEqual([
      { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", description: "anthropic" },
      { value: "claude-code/sonnet", label: "Claude Sonnet", description: "claude-code" },
      {
        value: RedsunWorkerModelTool.CLEAR,
        label: "Use the configured default",
        description: "Clear this session's worker model",
      },
    ])
  })

  it("always offers a way back to the configured default", () => {
    // Without this the override would be one-way: nothing else can clear it.
    expect(RedsunWorkerModelTool.options([]).at(-1)?.value).toBe(RedsunWorkerModelTool.CLEAR)
  })

  it("produces option values that parse as model refs", () => {
    const chosen = RedsunWorkerModelTool.options([model("anthropic", "claude-sonnet-4#high", "Sonnet high")])[0]!
    // The variant rides inside the ref, which is why there is no separate
    // worker_variant key on v2.
    expect(Model.Ref.parse(chosen.value)).toMatchObject({
      providerID: "anthropic",
      id: "claude-sonnet-4",
      variant: "high",
    })
  })

  it("stamps its form so the TUI can recognise it and show the model menu", () => {
    // The TUI answers this form with the same picker `/models` uses; without the
    // marker it would render as the generic dock form instead.
    expect(RedsunWorkerModelTool.FORM_KIND).toBe("worker-model")
  })
})

describe("RedsunWorkerModelTool input schema", () => {
  it("lowers to a root object schema so OpenAI accepts the function definition", () => {
    // Effect renders an empty Struct as `anyOf: [object, array]` with no root `type`,
    // which OpenAI rejects for every function tool.
    const tool = {
      name: RedsunWorkerModelTool.NAME,
      description: RedsunWorkerModelTool.DESCRIPTION,
      input: RedsunWorkerModelTool.INPUT,
      execute: () => {
        throw new Error("unused")
      },
    }
    expect(definition(tool as never).inputSchema).toMatchObject({ type: "object" })
  })
})
