import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("lists models without blocking on plugin initialization", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-model-endpoint-")))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "redsun.json"),
        JSON.stringify({
          providers: {
            custom: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { apiKey: "secret" },
              models: { chat: {} },
            },
          },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/model", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const request = Effect.fnUntraced(function* () {
      const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
      expect(response.status).toBe(200)
      const body: unknown = yield* Effect.promise(() => response.json())
      if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("Expected a model list response")
      return body["data"].some(
        (model) => isRecord(model) && model["providerID"] === "custom" && model["id"] === "chat",
      )
    })
    yield* request().pipe(
      Effect.filterOrFail((found) => found),
      Effect.retry(Schedule.spaced("10 millis")),
      Effect.timeout("2 seconds"),
    )
  }),
)

it.live("forces a refresh of the models.dev catalog", () =>
  Effect.gen(function* () {
    const source = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ "test-provider": { id: "test-provider", name: "Test", models: {} } }), {
          headers: { "content-type": "application/json" },
        }),
    })
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir("opencode-model-refresh-")),
      () => Effect.sync(() => source.stop(true)),
    )
    const server = yield* startServer(tmp.path, { models: { url: `http://127.0.0.1:${source.port}` } })
    const url = new URL("/api/model/refresh", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const response = yield* Effect.promise(() =>
      fetch(url, {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => response.text())
    expect(text).toBe("")
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
