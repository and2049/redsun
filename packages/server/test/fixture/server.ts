import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { ServerProcess } from "../../src/process"
import type { ModelsDev } from "@opencode-ai/core/models-dev"

export const startServer = Effect.fnUntraced(function* (
  directory: string,
  options?: { models?: ModelsDev.Options },
) {
  const server = yield* ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password: "secret",
    app: { version: "test-version" },
    database: { path: ":memory:" },
    config: { directory },
    fs: { filewatcher: false },
    models: options?.models ?? { fetch: false },
  })
  return {
    base: HttpServer.formatAddress(server.address),
    headers: { authorization: `Basic ${btoa("opencode:secret")}` },
  }
})
