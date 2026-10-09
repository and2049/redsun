import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { RemoteLocal } from "../../../services/remote-local"

export default Runtime.handler(
  Commands.commands.service.commands.set,
  Effect.fn("cli.service.set")(function* (input) {
    // `service set remote` predates `redsun remote computers`; a running service applies it live, without a restart.
    if (input.key === "remote" && (input.value === "true" || input.value === "false")) {
      const local = yield* RemoteLocal.connect().pipe(Effect.option)
      if (Option.isSome(local)) {
        const response = yield* local.value.request(
          "/api/remote/computers",
          "PUT",
          { enabled: input.value === "true" },
          6 * 60_000,
        )
        if (!response.ok)
          return yield* Effect.fail(new Error(yield* RemoteLocal.failure(response, "Computer access change failed")))
        return
      }
    }
    yield* ServiceConfig.set(input.key, input.value, Option.getOrUndefined(input.nestedValue))
  }),
)
