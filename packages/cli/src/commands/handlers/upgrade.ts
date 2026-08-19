import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Updater } from "../../services/updater"

const METHODS = ["curl", "powershell"] as const

export default Runtime.handler(
  Commands.commands.upgrade,
  Effect.fn("cli.upgrade")(function* (input) {
    const requested = Option.getOrUndefined(input.method)
    if (requested !== undefined && !METHODS.includes(requested as (typeof METHODS)[number]))
      return yield* Effect.fail(new Error(`Unknown installation method: ${requested}`))
    const updater = yield* Updater.Service
    const result = yield* updater.upgrade({
      target: Option.getOrUndefined(input.target),
      method: requested as Updater.Method | undefined,
    })
    if (result.status === "current") {
      process.stdout.write(`redsun ${result.to} is already installed${EOL}`)
      return
    }
    process.stdout.write(`upgraded redsun ${result.from} -> ${result.to} using ${result.method}${EOL}`)
  }),
)
