import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { RedsunWorkerModel } from "@opencode-ai/core/plugin/redsun/worker-model"

const ref = (input: string) => Model.Ref.parse(input)

const services = (input?: { stored?: unknown; known?: readonly string[] }): RedsunWorkerModel.Services => {
  const known = new Set(input?.known ?? ["anthropic/claude-sonnet-4", "openai/gpt-5.5"])
  const store = new Map<string, unknown>()
  if (input?.stored !== undefined) store.set(RedsunWorkerModel.key("ses_1"), input.stored)
  return {
    kv: {
      get: (key) => Effect.sync(() => store.get(key) as never),
      set: (key, value) => Effect.sync(() => void store.set(key, value)),
      remove: (key) => Effect.sync(() => void store.delete(key)),
    },
    catalog: {
      model: {
        get: (providerID, modelID) =>
          Effect.succeed(known.has(`${providerID}/${modelID}`) ? ({ id: modelID } as never) : undefined),
      },
    } as RedsunWorkerModel.Services["catalog"],
  }
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const resolve = (input: {
  services: RedsunWorkerModel.Services
  agentID?: string
  agentModel?: Model.Ref
  parentModel?: Model.Ref
}) =>
  run(
    RedsunWorkerModel.resolve({
      services: input.services,
      agentID: input.agentID ?? "worker",
      agentModel: input.agentModel,
      parentModel: input.parentModel,
      sessionID: "ses_1",
    }),
  )

describe("RedsunWorkerModel", () => {
  it("prefers the session override over the agent's configured model", async () => {
    expect(
      await resolve({
        services: services({ stored: "anthropic/claude-sonnet-4" }),
        agentModel: ref("openai/gpt-5.5"),
        parentModel: ref("openai/gpt-5.5"),
      }),
    ).toMatchObject({ providerID: "anthropic", id: "claude-sonnet-4" })
  })

  it("carries the variant through the session override", async () => {
    expect(await resolve({ services: services({ stored: "anthropic/claude-sonnet-4#high" }) })).toMatchObject({
      providerID: "anthropic",
      id: "claude-sonnet-4",
      variant: "high",
    })
  })

  it("falls back to the agent's configured model when no override is set", async () => {
    expect(await resolve({ services: services(), agentModel: ref("openai/gpt-5.5") })).toMatchObject({
      id: "gpt-5.5",
    })
  })

  it("falls through when the override names a model the catalog does not have", async () => {
    expect(
      await resolve({
        services: services({ stored: "anthropic/removed-model" }),
        agentModel: ref("openai/gpt-5.5"),
      }),
    ).toMatchObject({ id: "gpt-5.5" })
  })

  it("falls through when the override is unparseable", async () => {
    expect(
      await resolve({ services: services({ stored: "not-a-ref" }), agentModel: ref("openai/gpt-5.5") }),
    ).toMatchObject({ id: "gpt-5.5" })
  })

  it("fails a worker closed rather than inheriting the parent model", async () => {
    expect(await resolve({ services: services(), parentModel: ref("openai/gpt-5.5") })).toBeUndefined()
    expect(RedsunWorkerModel.inheritsParent("worker")).toBe(false)
  })

  it("lets other subagents inherit the parent model", async () => {
    expect(
      await resolve({ services: services(), agentID: "general", parentModel: ref("openai/gpt-5.5") }),
    ).toMatchObject({ id: "gpt-5.5" })
    expect(RedsunWorkerModel.inheritsParent("general")).toBe(true)
  })

  it("round-trips the session override through set and clear", async () => {
    const svc = services()
    await run(RedsunWorkerModel.setSessionOverride(svc, "ses_1", "anthropic/claude-sonnet-4"))
    expect(await resolve({ services: svc })).toMatchObject({ id: "claude-sonnet-4" })
    await run(RedsunWorkerModel.clearSessionOverride(svc, "ses_1"))
    expect(await resolve({ services: svc })).toBeUndefined()
  })

  it("names the config key an unconfigured worker needs", () => {
    expect(RedsunWorkerModel.unconfigured("worker")).toContain("agent.worker.model")
  })
})
