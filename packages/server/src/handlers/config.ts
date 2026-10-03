import { Config } from "@opencode/core/config"
import { ContextSettings } from "@opencode/core/config/context-settings"
import { ShellSelect } from "@opencode/core/shell/select"
import { InvalidRequestError, UnknownError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const error = (cause: Error) =>
  cause instanceof ContextSettings.InvalidConfig
    ? new InvalidRequestError({ message: cause.message })
    : new UnknownError({ message: cause.message })

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* ContextSettings.Service
    return handlers
      .handle("config.get", () => Config.Service.use((config) => config.entries()))
      .handle("config.context.get", () => settings.get().pipe(Effect.mapError(error)))
      .handle("config.context.update", ({ payload }) =>
        Effect.gen(function* () {
          const result = yield* settings.update(payload).pipe(Effect.mapError(error))
          yield* Config.Service.use((config) => config.reload())
          return result
        }),
      )
      .handle(
        "config.update",
        Effect.fn(function* (ctx) {
          const config = yield* Config.Service
          if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
          return yield* config.update(ctx.payload).pipe(Effect.orDie)
        }),
      )
      .handle(
        "config.shells",
        Effect.fn(function* () {
          const shell = yield* ShellSelect.Service
          if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
          return yield* shell.list()
        }),
      )
  }),
)
