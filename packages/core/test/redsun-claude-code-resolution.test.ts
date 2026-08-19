import { describe, expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import { ClaudeCodeModels } from "@opencode-ai/core/plugin/redsun/claude-code/models"
import { ModelResolver } from "@opencode-ai/core/model-resolver"

/**
 * REDSUN: the delegated provider only works if model resolution reaches the
 * `aisdk` hooks.
 *
 * Every other Claude Code test exercises the plugin's own modules with the hooks
 * already wired, which is why this went unnoticed through a whole phase: the
 * sentinel package had no `aisdk:` prefix, so `resolveCatalogModel` sent it to
 * `Provider.loadPackage`, which tried to import `@redsun/claude-code-delegated`
 * from npm and failed with `UnsupportedPackageError`. The language hook was
 * unreachable and every delegated turn died before the CLI was ever spawned --
 * the TUI showed a spinner for a moment and then nothing at all.
 *
 * So this asserts the seam rather than the constant: resolution must hand the
 * model to `loadAISDK`, which is where the hooks live.
 */
describe("Claude Code model resolution", () => {
  const model = ClaudeCodeModels.MODELS.find((item) => String(item.id) === "sonnet")!

  it("hands the delegated model to the aisdk loader, never to package loading", () => {
    const seen: string[] = []
    const resolved = Effect.runSyncExit(
      ModelResolver.fromCatalogModel(model as never, undefined, {
        loadAISDK: (input) => {
          seen.push(String(input.package))
          // Only the route's endpoint is read downstream; the rest of a real
          // LanguageModel is irrelevant to which path was taken.
          return Effect.succeed({ id: input.id, provider: input.providerID, route: { endpoint: {} } } as never)
        },
        loadPackage: () => Effect.die(new Error("the sentinel must never reach package loading")),
      }),
    )

    expect(seen).toEqual([ClaudeCodeModels.SENTINEL_PACKAGE])
    expect(Exit.isSuccess(resolved)).toBe(true)
  })

  it("fails loudly rather than falling back when no loader is supplied", () => {
    // The other half of the sentinel's contract: nothing else may claim it.
    const resolved = Effect.runSyncExit(ModelResolver.fromCatalogModel(model as never, undefined, {}))
    expect(Exit.isFailure(resolved)).toBe(true)
  })
})
