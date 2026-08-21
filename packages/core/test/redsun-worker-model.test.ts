import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { RedsunWorkerModel } from "@opencode-ai/core/plugin/redsun/worker-model"

const ref = (input: string) => Model.Ref.parse(input)

/** One user message, as the session history would hand it back. */
const message = (id: string, choice?: string) => ({
  id,
  type: "user" as const,
  ...(choice === undefined ? {} : { metadata: { [RedsunWorkerModel.METADATA_KEY]: choice } }),
})

const services = (input?: {
  stored?: unknown
  known?: readonly string[]
  messages?: ReadonlyArray<ReturnType<typeof message>>
}): RedsunWorkerModel.Services => {
  const known = new Set(input?.known ?? ["anthropic/claude-sonnet-4", "openai/gpt-5.5"])
  const kv = new Map<string, unknown>()
  if (input?.stored !== undefined) kv.set(RedsunWorkerModel.key("ses_1"), input.stored)
  return {
    kv: {
      get: (key) => Effect.sync(() => kv.get(key) as never),
      set: (key, value) => Effect.sync(() => void kv.set(key, value)),
      remove: (key) => Effect.sync(() => void kv.delete(key)),
      scan: () => Effect.succeed({ entries: [] }),
    },
    catalog: {
      model: {
        get: (providerID, modelID) =>
          Effect.succeed(known.has(`${providerID}/${modelID}`) ? ({ id: modelID } as never) : undefined),
      },
    } as RedsunWorkerModel.Services["catalog"],
    store: {
      context: () => Effect.succeed((input?.messages ?? []) as never),
    } as unknown as RedsunWorkerModel.Services["store"],
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

  it("takes the choice stamped on the newest prompt", async () => {
    expect(
      await resolve({
        services: services({
          messages: [message("msg_1", "openai/gpt-5.5"), message("msg_2", "anthropic/claude-sonnet-4")],
        }),
      }),
    ).toMatchObject({ id: "claude-sonnet-4" })
  })

  it("mirrors a prompt's choice into the store so a later read is cheap", async () => {
    const svc = services({ messages: [message("msg_1", "anthropic/claude-sonnet-4")] })
    await resolve({ services: svc })
    expect(await run(svc.kv.get(RedsunWorkerModel.key("ses_1")))).toEqual({
      ref: "anthropic/claude-sonnet-4",
      seen: "msg_1",
    })
  })

  it("lets a mid-turn choice outlive the prompt that turn started with", async () => {
    // The `worker_model` tool answers during a turn whose newest user message
    // already carries an older choice. Stamping the write against that message
    // is what stops the next read from treating the message as newer.
    const svc = services({ messages: [message("msg_1", "openai/gpt-5.5")] })
    await resolve({ services: svc })
    await run(RedsunWorkerModel.setSessionOverride(svc, "ses_1", "anthropic/claude-sonnet-4"))
    expect(await resolve({ services: svc })).toMatchObject({ id: "claude-sonnet-4" })
  })

  it("lets the next prompt supersede a mid-turn choice", async () => {
    const svc = services({ messages: [message("msg_1", "openai/gpt-5.5")] })
    await run(RedsunWorkerModel.setSessionOverride(svc, "ses_1", "anthropic/claude-sonnet-4"))
    // A newer prompt arrives carrying the user's current pick.
    const next = {
      ...svc,
      store: {
        context: () =>
          Effect.succeed([message("msg_1", "openai/gpt-5.5"), message("msg_2", "openai/gpt-5.5")] as never),
      } as unknown as RedsunWorkerModel.Services["store"],
    }
    expect(await resolve({ services: next })).toMatchObject({ id: "gpt-5.5" })
  })

  it("treats the clear sentinel on a prompt as no override", async () => {
    expect(
      await resolve({
        services: services({ messages: [message("msg_1", RedsunWorkerModel.CLEAR)] }),
        agentModel: ref("openai/gpt-5.5"),
      }),
    ).toMatchObject({ id: "gpt-5.5" })
  })

  it("still reads the bare string earlier builds stored", async () => {
    expect(await resolve({ services: services({ stored: "anthropic/claude-sonnet-4" }) })).toMatchObject({
      id: "claude-sonnet-4",
    })
  })

  it("names the config key an unconfigured worker needs", () => {
    expect(RedsunWorkerModel.unconfigured("worker")).toContain("agent.worker.model")
  })
})
