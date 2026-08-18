// REDSUN: the surface that reaches the session-scoped worker model.
//
// `RedsunWorkerModel.resolve` prefers a per-session override over the agent's
// configured model, but nothing could set one: upstream's model and variant
// dialogs are wired to `session.switchModel` (which changes the session's *own*
// model), and a plugin can add neither an HTTP route nor a KV route, so there is
// no way to point an existing dialog at a different sink.
//
// A tool over `Form.Service` is the way in. The TUI already renders any
// session-scoped form regardless of who created it, so `/worker-model` costs one
// model round-trip and no TUI, server, schema, or client-codegen work.
export * as RedsunWorkerModelTool from "./worker-model-tool.js"

import { ToolFailure } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Model } from "@opencode-ai/schema/model"
import type { Catalog } from "../../catalog.js"
import { Catalog as CatalogService } from "../../catalog.js"
import { Form } from "../../form.js"
import { KV } from "../../kv.js"
import { RedsunWorkerModel } from "./worker-model.js"

export const NAME = "worker_model"
export const COMMAND = "worker-model"
export const FIELD = "model"
export const CLEAR = "__clear__"

export const DESCRIPTION =
  "Ask the user which model worker subagents should run on for this session. " +
  "The choice outranks `agent.worker.model` for this session only. Call this when the user asks to " +
  "change the worker model, or after a worker refuses to run because no model is configured for it."

export const TEMPLATE =
  "Call the worker_model tool so I can choose which model worker subagents run on for this session."

/** Options for the picker: every available model, plus a way back to config. */
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
    const catalog = yield* CatalogService.Service
    // A tool's execute effect must have `never` requirements, so the services it
    // needs are bound here at plugin scope — the same shape subagent.ts uses.
    const services: RedsunWorkerModel.Services = { kv: yield* KV.Service, catalog }

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: NAME,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Schema.Struct({}),
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
                  metadata: { kind: "worker-model" },
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

              // Validate before storing so a bad value never becomes a warning
              // on every later delegation.
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

    // `Command.Info` is a prompt template, so the slash command is a nudge to
    // call the tool rather than a direct invocation.
    yield* ctx.command.transform((draft) => {
      draft.update(COMMAND, (command) => {
        command.template = TEMPLATE
        command.description = "choose the model worker subagents run on"
      })
    })
  }),
})

export type { Catalog }
