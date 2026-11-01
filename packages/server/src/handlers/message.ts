import { SessionMessage } from "@opencode/core/session/message"
import { Session } from "@opencode/core/session"
import { SessionMessagePin } from "@opencode/core/session/message-pin"
import { Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { wantsMediaRefs } from "../media-uri"
import {
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  SessionNotFoundError,
} from "@opencode/protocol/errors"
import { SessionMediaMessagesResponse } from "@opencode/protocol/groups/message"
import { failedMessageDecode, missingSession } from "./session-error"
import { RemoteProjection } from "../remote-projection"

const DefaultMessagesLimit = 50

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

const decodeCursor = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))

const cursor = {
  encode(message: { readonly id: SessionMessage.ID }, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(Buffer.from(input, "base64url").toString("utf8"))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    // REDSUN: session message pins.
    const pins = yield* SessionMessagePin.Service
    const missing =
      (sessionID: string, messageID = "") =>
      (error: SessionMessagePin.Missing): Effect.Effect<never, SessionNotFoundError | MessageNotFoundError> =>
        error.kind === "session"
          ? Effect.fail(new SessionNotFoundError({ sessionID, message: "Session not found" }))
          : Effect.fail(
              new MessageNotFoundError({
                sessionID,
                messageID,
                message: error.kind === "pin" ? "Pin not found" : "Message not found",
              }),
            )
    const invalid = (error: SessionMessagePin.Invalid) =>
      Effect.fail(new InvalidRequestError({ message: error.message }))

    return handlers
      .handle("session.pins", (ctx) =>
        pins
          .list(ctx.params.sessionID, ctx.query.cursor)
          .pipe(
            Effect.catchTag("SessionMessagePin.Missing", missing(ctx.params.sessionID)),
            Effect.catchTag("SessionMessagePin.Invalid", invalid),
          ),
      )
      .handle("session.pin", (ctx) =>
        pins
          .pin(ctx.params)
          .pipe(
            Effect.as(HttpApiSchema.NoContent.make()),
            Effect.catchTag("SessionMessagePin.Missing", missing(ctx.params.sessionID, ctx.params.messageID)),
            Effect.catchTag("SessionMessagePin.Invalid", invalid),
          ),
      )
      .handle("session.pin.rename", (ctx) =>
        pins
          .rename(ctx.params, ctx.payload.label)
          .pipe(
            Effect.as(HttpApiSchema.NoContent.make()),
            Effect.catchTag("SessionMessagePin.Missing", missing(ctx.params.sessionID, ctx.params.messageID)),
            Effect.catchTag("SessionMessagePin.Invalid", invalid),
          ),
      )
      .handle("session.unpin", (ctx) =>
        pins
          .unpin(ctx.params)
          .pipe(
            Effect.as(HttpApiSchema.NoContent.make()),
            Effect.catchTag("SessionMessagePin.Missing", missing(ctx.params.sessionID, ctx.params.messageID)),
            Effect.catchTag("SessionMessagePin.Invalid", invalid),
          ),
      )
      .handle(
        "session.messages",
        Effect.fn(function* (ctx) {
          if (ctx.query.cursor && ctx.query.order !== undefined)
            return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
          const decoded = ctx.query.cursor
            ? (Option.getOrUndefined(cursor.decode(ctx.query.cursor)) ??
              (yield* new InvalidCursorError({ message: "Invalid cursor" })))
            : undefined
          const order = decoded?.order ?? ctx.query.order ?? "desc"
          const input = {
            sessionID: ctx.params.sessionID,
            limit: ctx.query.limit ?? DefaultMessagesLimit,
            order,
            type: ctx.query.type,
            cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
          }
          const page = <Message extends { readonly id: SessionMessage.ID }>(messages: ReadonlyArray<Message>) => {
            const first = messages[0]
            const last = messages.at(-1)
            return {
              data: messages,
              cursor: {
                previous: first ? cursor.encode(first, order, "previous") : undefined,
                next: last ? cursor.encode(last, order, "next") : undefined,
              },
            }
          }
          // Companion history always uses the projected representation, including when media refs are requested.
          if (wantsMediaRefs(ctx.request) && !(yield* RemoteProjection.isRemote)) {
            const messages = yield* session
              .messagesWithRefs(input)
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              )
            return yield* HttpServerResponse.schemaJson(SessionMediaMessagesResponse)(page(messages)).pipe(Effect.orDie)
          }
          const messages = yield* session
            .messages(input)
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
            )
          // REDSUN: companion clients get the projected history.
          return page((yield* RemoteProjection.isRemote) ? messages.map(RemoteProjection.message) : messages)
        }),
      )
  }),
)
