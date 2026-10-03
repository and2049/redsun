export * as RedsunWorkerModelTool from "./worker-model-tool.js"

import { ToolFailure } from "@opencode/ai"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { WorkerModel } from "@opencode/plugin/worker-model"
import type { Model as ModelSchema } from "@opencode/schema/model"
import { Effect, Schema, Semaphore } from "effect"
import { Model } from "../../model.js"
import { Form } from "../../form.js"
import { KV } from "../../kv.js"
import { RedsunWorkerModel } from "./worker-model.js"

export const NAME = "worker_model"
export const FIELD = "model"
export const CLEAR = "__clear__"
export const FORM_KIND = "worker-model"
export const INPUT = Schema.Record(Schema.String, Schema.Unknown)

export const DESCRIPTION =
  "Ask the user which model worker subagents should run on for this session. " +
  "The choice outranks `agent.worker.model` for this session only. Call this when the user asks to " +
  "change the worker model, or after a worker refuses to run because no model is configured for it."

export const options = (models: readonly Model.Info[]) => [
  ...models.map((model) => ({
    value: `${model.providerID}/${model.id}`,
    label: model.name,
    description: model.providerID,
  })),
  { value: CLEAR, label: "Use the configured default", description: "Clear this session's worker model" },
]

/** Why `model` cannot be a session's worker model, if it cannot. */
export const invalid = Effect.fn("RedsunWorkerModelTool.invalid")(function* (models: Model.Interface, model: string) {
  const ref = RedsunWorkerModel.parse(model)
  if (ref === undefined) return `Not a model reference: ${model}`
  const known = yield* models.get(ref.providerID, ref.id)
  if (!known) return `No such model: ${model}`
  if (ref.variant !== undefined && !known.variants.some((variant) => variant.id === ref.variant))
    return `No variant "${ref.variant}" for ${ref.providerID}/${ref.id}`
  return undefined
})

/**
 * Worker-model access for a plugin: `resolve` for the subagent leaf and `choose` for the tool.
 * Writes go through the RPC, whose handler stores the choice and tells clients it changed.
 */
export const make = Effect.fn("RedsunWorkerModelTool.make")(function* (ctx: Context) {
  const forms = yield* Form.Service
  const services: RedsunWorkerModel.Services = { kv: yield* KV.Service, models: yield* Model.Service }

  // A Form, not a client-side picker: every client can answer it, and the TUI swaps in its model
  // dialog for forms of this kind.
  const choose = Effect.fn("RedsunWorkerModelTool.choose")(function* (sessionID: string) {
    const models = yield* services.models.available()
    if (models.length === 0) return yield* new ToolFailure({ message: "No models are available to choose from." })
    const state = yield* forms
      .ask({
        sessionID: sessionID as never,
        title: "Worker model",
        metadata: { kind: FORM_KIND },
        fields: [
          {
            key: FIELD,
            title: "Worker model",
            description: "The model worker subagents run on for this session.",
            type: "string",
            options: options(models),
            // A client may answer with a variant ("provider/model#high"); the RPC validates it.
            custom: true,
            required: true,
          },
        ],
      })
      .pipe(Effect.orDie)
    if (state.status === "cancelled")
      return yield* new ToolFailure({ message: "The user dismissed the worker model picker." })
    const chosen = state.answer[FIELD]
    if (typeof chosen !== "string" || !chosen) return yield* new ToolFailure({ message: "No worker model was chosen." })
    const model = chosen === CLEAR ? undefined : chosen
    yield* ctx
      .rpc(WorkerModel.rpc)
      .set(model === undefined ? { sessionID } : { sessionID, model })
      .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
    return model
  })

  /** Session choice, then the agent's model, then the parent's (not for workers); an unset worker asks. */
  const resolve = Effect.fn("RedsunWorkerModelTool.resolve")(function* (input: {
    readonly agentID: string
    readonly agentModel: ModelSchema.Ref | undefined
    readonly parentModel: ModelSchema.Ref | undefined
    readonly sessionID: string
  }) {
    const model = yield* RedsunWorkerModel.resolve({ services, ...input })
    if (model !== undefined) return model
    const chosen = input.agentID === "worker" ? yield* choose(input.sessionID) : undefined
    const ref = chosen === undefined ? undefined : RedsunWorkerModel.parse(chosen)
    if (ref !== undefined) return ref
    return yield* new ToolFailure({ message: RedsunWorkerModel.unconfigured(input.agentID) })
  })

  return { choose, resolve }
})

// Check-then-write must not interleave, or a client default could replace a fresh choice. The
// choice lives in the process-global KV and each location runs its own plugin instance, so the
// lock is module-wide too.
const writes = Semaphore.makeUnsafe(1)

export const Plugin = define({
  id: "redsun.tool.worker-model",
  effect: Effect.fn(function* (ctx) {
    const kv = yield* KV.Service
    const models = yield* Model.Service
    const workers = yield* make(ctx)

    const registration: RpcRegistration<typeof WorkerModel.rpc> = yield* ctx.rpc
      .register(WorkerModel.rpc, {
        get: (input) => RedsunWorkerModel.stored(kv, input.sessionID),
        set: (input, context) =>
          Effect.gen(function* () {
            const current = yield* RedsunWorkerModel.stored(kv, input.sessionID)
            if (input.ifUnset && current.chosen) return current
            if (input.model !== undefined) {
              const reason = yield* invalid(models, input.model)
              if (reason !== undefined)
                return yield* Effect.fail(context.error("invalid_model", reason, { model: input.model }))
            }
            yield* kv.set(RedsunWorkerModel.key(input.sessionID), RedsunWorkerModel.encode(input.model, current))
            const choice = yield* RedsunWorkerModel.stored(kv, input.sessionID)
            yield* registration.events.emit("changed", { sessionID: input.sessionID, ...choice }).pipe(Effect.ignore)
            return choice
          }).pipe(writes.withPermit),
      })
      .pipe(Effect.orDie)

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: NAME,
          options: { codemode: false },
          description: DESCRIPTION,
          input: INPUT,
          output: Schema.Struct({ model: Schema.String }),
          execute: (_input, context) =>
            Effect.gen(function* () {
              const chosen = yield* workers.choose(context.sessionID)
              if (chosen === undefined) {
                return {
                  output: { model: "" },
                  content: "Cleared this session's worker model; workers fall back to the configured default.",
                }
              }

              return {
                output: { model: chosen },
                content: `Worker subagents in this session will run on ${chosen}.`,
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
