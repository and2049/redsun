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
import { KV } from "../../../kv.js"
import { Location } from "../../../location.js"
import { ClaudeCodeExecutable } from "./executable.js"
import { ClaudeCodeLanguageModel } from "./language-model.js"
import { ClaudeCodeModels } from "./models.js"
import { ClaudeCodeQuery } from "./query.js"
import { ClaudeCodeSessions } from "./sessions.js"

/**
 * Hidden agents that generate a title, a summary, or a compaction. They must run
 * one-shot: reusing the interactive process would inject their prompt into the
 * user's conversation and, for compaction, ask Claude Code to summarize a
 * transcript it already owns.
 */
const ONE_SHOT_AGENTS = new Set(["title", "summary", "compaction"])

const cursorKey = (sessionID: string) => `redsun.claude-code-session/${sessionID}`

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

    const location = yield* Location.Service
    const kv = yield* KV.Service

    // Resume cursors are read synchronously inside doStream, so keep a mirror of
    // the durable KV values in memory and write through on change.
    const cursors = new Map<string, string>()
    // Which agent is driving each session's current request, recorded by the
    // session context hook immediately before the model call for that session.
    const agents = new Map<string, string>()

    const manager = new ClaudeCodeSessions.SessionManager(ClaudeCodeQuery.defaultCreateQuery)

    yield* ctx.session.hook(
      "context",
      Effect.fn(function* (event) {
        agents.set(event.sessionID, event.agent)
        const stored = yield* kv.get(cursorKey(event.sessionID))
        if (typeof stored === "string" && stored) cursors.set(event.sessionID, stored)
      }),
    )

    yield* ctx.aisdk.hook(
      "language",
      Effect.fn(function* (event) {
        if (event.model.providerID !== ClaudeCodeModels.PROVIDER_ID) return
        event.language = ClaudeCodeLanguageModel.make({
          modelID: event.model.modelID ?? event.model.id,
          config: {
            executablePath: resolution.path,
            cwd: location.directory,
            permissionMode: settings?.permission_mode,
            configDir: settings?.config_dir,
            extraArgs: settings?.extra_args,
            env: settings?.env,
          },
          manager,
          createQuery: ClaudeCodeQuery.defaultCreateQuery,
          hooks: {
            isOneShot: (sessionID) => ONE_SHOT_AGENTS.has(agents.get(sessionID) ?? ""),
            resumeCursor: (sessionID) => cursors.get(sessionID),
            onCursor: (sessionID, claudeSessionID) => {
              if (cursors.get(sessionID) === claudeSessionID) return
              cursors.set(sessionID, claudeSessionID)
              Effect.runFork(kv.set(cursorKey(sessionID), claudeSessionID))
            },
          },
        })
      }),
    )

    yield* Effect.addFinalizer(() => Effect.sync(() => manager.stopAll()))
  }),
})
