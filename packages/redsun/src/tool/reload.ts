import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"

export const ReloadTool = Tool.define(
  "reload",
  Effect.succeed({
    description: "Reload redsun after changing extension, tool, or configuration files.",
    parameters: Schema.Struct({}),
    execute: () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const { ExtensionRuntime } = yield* Effect.promise(() => import("@/extension/runtime"))
        setTimeout(() => ExtensionRuntime.reload(instance.directory), 250)
        return { title: "Reload queued", output: "redsun will reload after this turn.", metadata: {} }
      }),
  }),
)
