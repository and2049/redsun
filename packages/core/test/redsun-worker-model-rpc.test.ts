import { expect } from "bun:test"
import { WorkerModel } from "@opencode/plugin/worker-model"
import { Effect, Fiber, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Form } from "@opencode/core/form"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/core/session"
import { Model } from "@opencode/core/model"
import { RedsunWorkerModel } from "@opencode/core/plugin/redsun/worker-model"
import { RedsunWorkerModelTool } from "@opencode/core/plugin/redsun/worker-model-tool"
import { Rpc } from "@opencode/core/rpc"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { PluginPermissionTestLayer } from "./plugin/fixture"

// REDSUN: the worker-model RPC is the only writer of a session's worker model. Clients set it
// directly (no prompt metadata), and every write tells subscribers what changed.

const it = testEffect(PluginPermissionTestLayer)

const catalog = {
  get: (providerID: string, modelID: string) =>
    Effect.succeed(
      providerID === "anthropic" && modelID === "claude-sonnet-4"
        ? ({ providerID, id: modelID, variants: [{ id: "high" }] } as never)
        : undefined,
    ),
  available: () => Effect.succeed([{ providerID: "anthropic", id: "claude-sonnet-4", name: "Sonnet" }] as never),
} as unknown as Model.Interface

const setup = Effect.gen(function* () {
  const rpc = yield* Rpc.Service
  yield* registerToolPlugin(RedsunWorkerModelTool.Plugin, {
    rpc: Object.assign(rpc.client, { register: rpc.register }),
  }).pipe(Effect.provideService(Model.Service, catalog))
  return rpc.client(WorkerModel.rpc)
})

it.live("stores, reads back and clears a session's worker model, announcing each change", () =>
  Effect.gen(function* () {
    const client = yield* setup
    const kv = yield* KV.Service
    const changes = yield* client.events.subscribe("changed").pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow

    expect(yield* client.get({ sessionID: "ses_1" })).toEqual({ chosen: false, revision: 0 })
    const chosen = { chosen: true, model: "anthropic/claude-sonnet-4#high", revision: 1 }
    expect(yield* client.set({ sessionID: "ses_1", model: "anthropic/claude-sonnet-4#high" })).toEqual(chosen)
    expect(yield* client.get({ sessionID: "ses_1" })).toEqual(chosen)
    expect(yield* kv.get(RedsunWorkerModel.key("ses_1"))).toEqual({
      model: "anthropic/claude-sonnet-4#high",
      revision: 1,
    })

    expect(yield* client.set({ sessionID: "ses_1" })).toEqual({ chosen: true, revision: 2 })
    expect(yield* client.get({ sessionID: "ses_1" })).toEqual({ chosen: true, revision: 2 })

    const events = Array.from(yield* Fiber.join(changes))
    expect(events.map((event) => event.data)).toEqual([
      { sessionID: "ses_1", chosen: true, model: "anthropic/claude-sonnet-4#high", revision: 1 },
      { sessionID: "ses_1", chosen: true, revision: 2 },
    ])
  }),
)

it.live("rejects a model the catalog does not offer and leaves the choice alone", () =>
  Effect.gen(function* () {
    const client = yield* setup
    yield* client.set({ sessionID: "ses_1", model: "anthropic/claude-sonnet-4" })
    for (const model of ["not-a-ref", "anthropic/removed", "anthropic/claude-sonnet-4#max"])
      expect(yield* client.set({ sessionID: "ses_1", model }).pipe(Effect.flip)).toMatchObject({
        type: "invalid_model",
        data: { model },
      })
    expect(yield* client.get({ sessionID: "ses_1" })).toEqual({
      chosen: true,
      model: "anthropic/claude-sonnet-4",
      revision: 1,
    })
  }),
)

it.live("applies a client default only to a session nobody has chosen for, including the default", () =>
  Effect.gen(function* () {
    const client = yield* setup
    const offer = (sessionID: string) => client.set({ sessionID, model: "anthropic/claude-sonnet-4", ifUnset: true })
    expect(yield* offer("ses_new")).toEqual({ chosen: true, model: "anthropic/claude-sonnet-4", revision: 1 })

    yield* client.set({ sessionID: "ses_chosen", model: "anthropic/claude-sonnet-4#high" })
    expect(yield* offer("ses_chosen")).toEqual({ chosen: true, model: "anthropic/claude-sonnet-4#high", revision: 1 })

    // The worker_model tool's "Use the configured default" must survive the next client prompt.
    yield* client.set({ sessionID: "ses_default" })
    expect(yield* offer("ses_default")).toEqual({ chosen: true, revision: 1 })
  }),
)

it.live("accepts a variant answered through the worker-model form", () =>
  Effect.gen(function* () {
    yield* setup
    const forms = yield* Form.Service
    const here = yield* Location.Service
    const session = yield* (yield* Session.Service).create({
      location: Location.Ref.make({ directory: here.directory, workspaceID: here.workspaceID }),
    })
    yield* (yield* Bus.Service).listen((event) => {
      if (event.type !== Form.Event.Created.type) return Effect.void
      const form = (event.data as { form: Form.Info }).form
      return forms
        .reply({ id: form.id, answer: { model: "anthropic/claude-sonnet-4#high" } })
        .pipe(Effect.orDie, Effect.asVoid)
    })
    const result = yield* executeTool(yield* Tool.Service, {
      ...toolIdentity,
      sessionID: session.id,
      call: { type: "tool-call", id: "call_worker", name: RedsunWorkerModelTool.NAME, input: {} },
    })
    expect(result.status).toBe("completed")
    expect(yield* (yield* KV.Service).get(RedsunWorkerModel.key(session.id))).toEqual({
      model: "anthropic/claude-sonnet-4#high",
      revision: 1,
    })
  }),
)
