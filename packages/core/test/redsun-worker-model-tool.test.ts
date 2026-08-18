import { describe, expect, it } from "bun:test"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { RedsunWorkerModelTool } from "@opencode-ai/core/plugin/redsun/worker-model-tool"

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

  it("nudges the model to call the tool rather than answering itself", () => {
    // Command.Info is a prompt template, so the slash command cannot invoke a
    // tool directly.
    expect(RedsunWorkerModelTool.TEMPLATE).toContain(RedsunWorkerModelTool.NAME)
  })
})
