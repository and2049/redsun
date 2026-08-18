// REDSUN: registers the delegated Claude Code provider.
//
// Autodetected, matching V1: the provider appears only when the `claude` binary
// resolves. Sign-in is deliberately NOT probed at startup — that would cost a
// subprocess on every boot — so an unauthenticated CLI surfaces an actionable
// error on the first turn instead.
export * as ClaudeCodeProviderPlugin from "./provider.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../../config.js"
import { ClaudeCodeExecutable } from "./executable.js"
import { ClaudeCodeModels } from "./models.js"

export const Plugin = define({
  id: "redsun.provider.claude-code",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const settings = Config.latest(yield* config.entries(), "claude_code")
    if (settings?.enabled === false) return

    const resolution = ClaudeCodeExecutable.resolve(settings?.binary_path)
    if ("error" in resolution) {
      yield* Effect.logDebug("claude code provider unavailable", { reason: resolution.error })
      return
    }

    yield* ctx.catalog.transform((catalog) => {
      const info = ClaudeCodeModels.providerInfo()
      catalog.provider.update(ClaudeCodeModels.PROVIDER_ID, (provider) => {
        provider.name = info.name
        provider.activation = info.activation
        provider.package = info.package
      })
      for (const model of ClaudeCodeModels.MODELS) {
        catalog.model.update(ClaudeCodeModels.PROVIDER_ID, model.id, (draft) => {
          Object.assign(draft, model)
        })
      }
    })
  }),
})
