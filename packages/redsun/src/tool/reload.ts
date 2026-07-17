import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"

export const ReloadTool = Tool.define("reload", Effect.succeed({
  description: "Reload Redsun after changing extension, tool, or configuration files.",
  parameters: Schema.Struct({}),
  execute: () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const { InstanceRuntime } = yield* Effect.promise(() => import("@/project/instance-runtime"))
      setTimeout(() => void InstanceRuntime.reloadInstance({ directory: instance.directory }), 250)
      return { title: "Reload queued", output: "Redsun will reload after this turn.", metadata: {} }
    }),
}))
