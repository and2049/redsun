import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { EventFeed } from "../event-feed"
import { RemoteService } from "../remote-control"
import { RemoteAccess } from "../remote-access"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    const remote = yield* RemoteService.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: Event.ID.create(),
          type: "server.connected",
          data: {},
        } as const
        const principal = yield* Effect.serviceOption(RemoteService.Principal)
        const source = Stream.unwrap(
          feed.subscribe.pipe(Effect.map((live) => Stream.make(EventFeed.frame(connected)).pipe(Stream.concat(live)))),
        )
        const output =
          principal._tag === "None"
            ? source
            : source.pipe(
                Stream.map(RemoteAccess.eventFrame),
                Stream.filter((frame) => frame !== ""),
                Stream.merge(
                  Stream.fromEffect(
                    Effect.callback<string>((resume) => {
                      const disconnect = remote.connect(principal.value, () => resume(Effect.succeed("")))
                      return Effect.sync(disconnect)
                    }),
                  ),
                  { haltStrategy: "right" },
                ),
              )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
