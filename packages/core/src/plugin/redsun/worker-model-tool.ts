export * as RedsunWorkerModelTool from "./worker-model-tool.js"

import { ToolFailure } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { Catalog } from "../../catalog.js"
import { Form } from "../../form.js"
import { KV } from "../../kv.js"
import { SessionStore } from "../../session/store.js"
import { RedsunWorkerModel } from "./worker-model.js"

export const NAME = "worker_model"
export const FIELD = "model"
export const CLEAR = RedsunWorkerModel.CLEAR
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

export const Plugin = define({
  id: "redsun.tool.worker-model",
  effect: Effect.fn(function* (ctx) {
    const forms = yield* Form.Service
    const catalog = yield* Catalog.Service
    const services: RedsunWorkerModel.Services = {
      kv: yield* KV.Service,
      catalog,
      store: yield* SessionStore.Service,
    }

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
              const models = yield* catalog.model.available()
              if (models.length === 0)
                return yield* new ToolFailure({ message: "No models are available to choose from." })

              const state = yield* forms
                .ask({
                  sessionID: context.sessionID,
                  title: "Worker model",
                  metadata: { kind: FORM_KIND },
                  fields: [
                    {
                      key: FIELD,
                      title: "Worker model",
                      description: "The model worker subagents run on for this session.",
                      type: "string",
                      options: options(models),
                      required: true,
                    },
                  ],
                })
                .pipe(Effect.orDie)

              if (state.status === "cancelled")
                return yield* new ToolFailure({ message: "The user dismissed the worker model picker." })

              const chosen = state.answer[FIELD]
              if (typeof chosen !== "string" || !chosen)
                return yield* new ToolFailure({ message: "No worker model was chosen." })

              if (chosen === CLEAR) {
                yield* RedsunWorkerModel.clearSessionOverride(services, context.sessionID)
                return {
                  output: { model: "" },
                  content: "Cleared this session's worker model; workers fall back to the configured default.",
                }
              }

              const ref = yield* Effect.try(() => Model.Ref.parse(chosen)).pipe(
                Effect.mapError(() => new ToolFailure({ message: `Not a model reference: ${chosen}` })),
              )
              const known = yield* catalog.model.get(ref.providerID, ref.id)
              if (!known) return yield* new ToolFailure({ message: `No such model: ${chosen}` })

              yield* RedsunWorkerModel.setSessionOverride(services, context.sessionID, chosen)
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
