import { Effect } from "effect"
import { main } from "redsun-remote-control"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"

export default Runtime.handler(
  Commands.commands.remote.commands.companion,
  Effect.fn("cli.remote.companion")(function* (input) {
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    yield* Effect.promise(async () => {
      try {
        process.exitCode = await main(input.args, { signal: controller.signal, name: "redsun remote companion" })
      } catch {
        console.error("Companion operation failed")
        process.exitCode = 1
      } finally {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
      }
    }).pipe(Effect.uninterruptible)
  }),
)
