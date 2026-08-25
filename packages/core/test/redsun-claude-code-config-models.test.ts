import { describe, expect } from "bun:test"
import { Document, Info, type Entry } from "@opencode-ai/schema/config"
import { Effect, Exit, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { Model } from "@opencode-ai/core/model"
import { ModelResolver } from "@opencode-ai/core/model-resolver"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ClaudeCodeModels } from "@opencode-ai/core/plugin/redsun/claude-code/models"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

/**
 * REDSUN: users reach models the curated list doesn't ship through upstream's
 * `providers.claude-code.models` config. That path only works because a
 * config-added model carries no `package` and `projectModel` falls back to the
 * provider's sentinel, which the aisdk hooks then claim by providerID. This
 * drives the real registration entry point (`applyCatalog`) and the real
 * `ConfigProviderPlugin` against a real Catalog, so a regression in any link
 * of that chain fails here rather than at the first live delegated turn.
 */

const it = testEffect(PluginTestLayer)

const decode = Schema.decodeUnknownSync(Info)

const addProviderPlugin = Effect.fn(function* (entries: Entry[]) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provide(Config.testLayer(entries)))
})

const configDocument = (info: unknown) => new Document({ type: "document", info: decode(info) })

describe("Claude Code config-declared models", () => {
  it.effect("inherits the sentinel package so a config-added id resolves as delegated", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform(ClaudeCodeModels.applyCatalog)
      yield* addProviderPlugin([
        configDocument({
          providers: {
            "claude-code": {
              models: {
                "claude-opus-4-1": { name: "Claude Opus 4.1", limit: { context: 200_000, output: 32_000 } },
              },
            },
          },
        }),
      ])

      const model = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("claude-opus-4-1"))
      expect(model).toBeDefined()
      expect(model?.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
      expect(model?.name).toBe("Claude Opus 4.1")
      expect(model?.limit).toEqual({ context: 200_000, output: 32_000 })
      expect(model?.enabled).toBe(true)
      expect(ClaudeCodeModels.isDelegated(model!)).toBe(true)

      // The projected model must route to the aisdk loader, where the
      // provider's hooks live -- never to npm package loading.
      const seen: string[] = []
      const resolved = Effect.runSyncExit(
        ModelResolver.fromCatalogModel(model as never, undefined, {
          loadAISDK: (input) => {
            seen.push(String(input.package))
            return Effect.succeed({ id: input.id, provider: input.providerID, route: { endpoint: {} } } as never)
          },
          loadPackage: () => Effect.die(new Error("a config-added delegated model must never reach package loading")),
        }),
      )
      expect(seen).toEqual([ClaudeCodeModels.SENTINEL_PACKAGE])
      expect(Exit.isSuccess(resolved)).toBe(true)
    }),
  )

  it.effect("keeps the provider record intact when config only adds models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform(ClaudeCodeModels.applyCatalog)
      yield* addProviderPlugin([
        configDocument({
          providers: {
            "claude-code": { models: { "claude-opus-4-1": {} } },
          },
        }),
      ])

      const provider = yield* catalog.provider.get(ClaudeCodeModels.PROVIDER_ID)
      expect(provider?.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
      expect(provider?.name).toBe(ClaudeCodeModels.DISPLAY_NAME)
    }),
  )

  it.effect("hides a retired pinned model until user config resurrects it", () =>
    Effect.gen(function* () {
      // The auto-retire path: a substitution observed at runtime lands in the
      // retired map the registered transform reads, and user config -- which
      // runs after it -- stays the final word.
      const catalog = yield* Catalog.Service
      const retired = new Map([["claude-opus-4-8", { served: "claude-opus-5" }]])
      yield* catalog.transform((draft) => ClaudeCodeModels.applyCatalog(draft, { retired }))

      const hidden = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("claude-opus-4-8"))
      expect(hidden?.enabled).toBe(false)

      yield* addProviderPlugin([
        configDocument({
          providers: {
            "claude-code": { models: { "claude-opus-4-8": { disabled: false } } },
          },
        }),
      ])
      const resurrected = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("claude-opus-4-8"))
      expect(resurrected?.enabled).toBe(true)
    }),
  )

  it.live("re-applies live retirements and discoveries on catalog.reload", () =>
    Effect.gen(function* () {
      // provider.ts registers the transform once over mutable state and calls
      // reload() when a substitution or picker probe lands; the transform must
      // see the mutation. Live clock: reload's debounce sleeps for real.
      const catalog = yield* Catalog.Service
      const retired = new Map<string, ClaudeCodeModels.Retirement>()
      let discovered: ClaudeCodeModels.Discovered[] = []
      yield* catalog.transform((draft) => ClaudeCodeModels.applyCatalog(draft, { retired, discovered }))

      const before = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("claude-opus-4-8"))
      expect(before?.enabled).toBe(true)

      retired.set("claude-opus-4-8", { served: "claude-opus-5" })
      discovered = [{ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" }]
      yield* catalog.reload()

      const after = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("claude-opus-4-8"))
      expect(after?.enabled).toBe(false)
      const alias = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("sonnet"))
      expect(alias?.name).toBe("Claude Sonnet 5")
    }),
  )

  it.effect("lets user config override a curated pinned model", () =>
    Effect.gen(function* () {
      // Registration order (claude-code plugin before ConfigProviderPlugin in
      // internal.ts) means config transforms run after `applyCatalog`, so a
      // user override of a curated entry wins -- also on catalog.reload().
      const catalog = yield* Catalog.Service
      yield* catalog.transform(ClaudeCodeModels.applyCatalog)
      yield* addProviderPlugin([
        configDocument({
          providers: {
            "claude-code": {
              models: {
                "claude-sonnet-4-5": { name: "Sonnet 4.5 (pinned)", disabled: true },
              },
            },
          },
        }),
      ])

      const model = yield* catalog.model.get(ClaudeCodeModels.PROVIDER_ID, Model.ID.make("claude-sonnet-4-5"))
      expect(model?.name).toBe("Sonnet 4.5 (pinned)")
      expect(model?.enabled).toBe(false)
      expect(model?.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
      expect(model?.limit.context).toBe(200_000)
    }),
  )
})
