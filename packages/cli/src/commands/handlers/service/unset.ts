import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { RemoteLocal } from "../../../services/remote-local"

export default Runtime.handler(
  Commands.commands.service.commands.unset,
  Effect.fn("cli.service.unset")(function* (input) {
    // The running service owns computer access: it is turned off live, and its address is kept (a new one comes
    // from `redsun remote computers rotate`). Only a stopped service's file forgets the route here.
    if (input.key === "remote") {
      const local = yield* RemoteLocal.connect().pipe(Effect.option)
      if (Option.isSome(local)) {
        const response = yield* local.value.request("/api/remote/computers", "PUT", { enabled: false })
        if (!response.ok)
          return yield* Effect.fail(new Error(yield* RemoteLocal.failure(response, "Computer access change failed")))
        process.stderr.write(
          "Computer access is off; its address is kept. `redsun remote computers rotate` issues a new one.\n",
        )
        return
      }
    }
    yield* ServiceConfig.unset(input.key, Option.getOrUndefined(input.name))
  }),
)
