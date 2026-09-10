import { expect } from "bun:test"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { Session } from "@opencode/core/session"
import { OpenCode } from "@opencode/client"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live(
  "disable leaves an admitted execution running and prompt IDs reconcile without resubmission",
  () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped("redsun-remote-admission-")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      let interrupted = false
      const context = yield* Layer.build(
        createRoutes(
          {
            password: "fixture",
            database: { path: ":memory:" },
            models: { fetch: false },
            fs: { filewatcher: false },
            config: { directory: temporary.path, project: false },
            remoteControl: { file: path.join(temporary.path, "service.json") },
          },
          () => [],
          [
            SessionRunnerLLM.node.replace(
              Layer.succeed(SessionRunner.Service, {
                drain: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined)
                    yield* Deferred.await(release)
                    yield* Deferred.succeed(finished, undefined)
                    return SessionRunner.DrainResult.Complete()
                  }).pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        interrupted = true
                      }),
                    ),
                  ),
              }),
            ),
          ],
        ).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const makeClient = (authorization: string) =>
        OpenCode.make({
          baseUrl: "http://localhost",
          headers: { authorization },
          fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
            preconnect: () => {},
          }),
        })
      const local = makeClient(`Basic ${btoa("opencode:fixture")}`)
      const status = yield* Effect.promise(() => local.remote.status())
      const token = randomBytes(32).toString("base64url")
      const credentialID = randomBytes(16).toString("hex")
      yield* Effect.promise(() =>
        local.remote.enroll({
          backendID: status.backendID!,
          credentialID,
          digest: createHash("sha256").update(token).digest("hex"),
        }),
      )
      yield* Effect.promise(() => local.remote.policy({ enabled: true }))
      const remote = makeClient(`Bearer rc1.${credentialID}.${token}`)
      for (const [method, route] of [
        ["GET", "/api/remote/companion"],
        ["PUT", "/api/remote/companion"],
        ["POST", "/api/remote/companion/registration"],
        ["DELETE", "/api/remote/companion/registration"],
        ["POST", "/api/remote/companion/approval"],
        ["GET", "/api/remote/tailscale"],
        ["POST", "/api/remote/tailscale"],
      ]) {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost${route}`, {
              method,
              headers: { authorization: `Bearer rc1.${credentialID}.${token}` },
            }),
          ),
        )
        expect(response.status).toBe(401)
      }
      const session = yield* Effect.promise(() =>
        remote.session.create({ title: "Admission fixture", location: { directory: temporary.path } }),
      )
      const admitted = yield* Effect.promise(() =>
        remote.session.prompt({ sessionID: session.id, id: "msg_remote_fixture", text: "First payload" }),
      )
      yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
      yield* Effect.promise(() => local.remote.policy({ enabled: false }))
      expect(interrupted).toBe(false)
      expect(admitted.payload.text).toBe("First payload")
      expect((yield* Context.get(context, Session.Service).active).has(Session.ID.make(session.id))).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(finished).pipe(Effect.timeout("5 seconds"))
      expect(interrupted).toBe(false)
      yield* Effect.promise(() => local.remote.policy({ enabled: true }))
      const inbox = yield* Effect.promise(() => remote.session.inbox.list({ sessionID: session.id }))
      expect(inbox.some((item) => item.id === admitted.id)).toBe(true)
      const reconciled = yield* Effect.promise(() =>
        remote.session.prompt({ sessionID: session.id, id: admitted.id, text: "Different payload is not an edit" }),
      )
      expect(reconciled.payload.text).toBe("First payload")
    }),
  15_000,
)
