import { Effect, Semaphore } from "effect"
import type { Credential } from "@opencode/schema/credential"
import { Usage } from "../usage.js"
import type { Context } from "./plugin.js"

/** Provider-owned collectors share the RPC contract, auth gate and short-lived cache. */
export const registerUsage = Effect.fn(function* (
  ctx: Context,
  input: {
    providerID: string
    methods: readonly string[]
    read: (credential: Credential.OAuth, signal: AbortSignal) => Promise<Usage.Data>
  },
) {
  const lock = Semaphore.makeUnsafe(1)
  let cache: { key: string; value: Usage.Snapshot } | undefined
  yield* ctx.rpc
    .register(Usage.rpc(input.providerID), {
      read: () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active(input.providerID)
          if (!connection) {
            cache = undefined
            return { connected: false, windows: [], updatedAt: Date.now() }
          }
          const credential = yield* ctx.integration.connection.resolve(connection)
          if (credential?.type !== "oauth" || !input.methods.includes(credential.methodID)) {
            cache = undefined
            return { connected: false, windows: [], updatedAt: Date.now() }
          }
          // Credential identity and metadata bind cached quotas to the selected account.
          const key = JSON.stringify([connection, credential.metadata])
          if (cache?.key === key && Date.now() - cache.value.updatedAt < 60_000) return cache.value
          const data = yield* Effect.tryPromise((signal) => input.read(credential, signal)).pipe(
            Effect.timeout("20 seconds"),
            Effect.orElseSucceed(
              (): Usage.Data => ({
                windows: [],
                message: "Could not load usage. Check the provider's sign-in and try again shortly.",
              }),
            ),
          )
          const value = { ...data, connected: true, updatedAt: Date.now() }
          cache = { key, value }
          return value
        }).pipe(
          lock.withPermit,
          Effect.orElseSucceed(
            (): Usage.Snapshot => ({
              connected: true,
              windows: [],
              updatedAt: Date.now(),
              message: "Could not resolve the account. Reconnect the provider and try again.",
            }),
          ),
        ),
    })
    .pipe(Effect.orDie)
})
