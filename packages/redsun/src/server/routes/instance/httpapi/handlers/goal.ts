import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { ConflictError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { GoalV2 } from "@/session/goal-v2"
import { GoalApi, type GoalState } from "../groups/goal"

const toApiState = (state: GoalV2.GoalState): GoalState => ({
  condition: state.condition,
  ...(state.budget === undefined ? {} : { budget: state.budget }),
  attempts: state.attempts,
  ...(state.lastVerdict === undefined ? {} : { lastVerdict: state.lastVerdict }),
})

export const goalHandlers = HttpApiBuilder.group(GoalApi, "redsun.goal", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db

    const assertSession = (sessionID: SessionSchema.ID) =>
      sessions.get(sessionID).pipe(
        Effect.catchTag(
          "Session.NotFoundError",
          (error) =>
            new SessionNotFoundError({
              sessionID: error.sessionID,
              message: `Session not found: ${error.sessionID}`,
            }),
        ),
      )

    return handlers
      .handle(
        "goal.get",
        Effect.fn(function* (ctx) {
          yield* assertSession(ctx.params.sessionID)
          const state = yield* GoalV2.get(db, ctx.params.sessionID)
          return { data: state === undefined ? {} : { goal: toApiState(state) } }
        }),
      )
      .handle(
        "goal.set",
        Effect.fn(function* (ctx) {
          yield* assertSession(ctx.params.sessionID)
          yield* GoalV2.set(events, {
            sessionID: ctx.params.sessionID,
            condition: ctx.payload.condition,
            ...(ctx.payload.budget === undefined ? {} : { budget: ctx.payload.budget }),
          })
          const admitted =
            ctx.payload.prompt === false
              ? undefined
              : yield* sessions
                  .prompt({
                    sessionID: ctx.params.sessionID,
                    prompt: { text: ctx.payload.condition },
                    delivery: "steer",
                  })
                  .pipe(
                    Effect.catchTag(
                      "Session.NotFoundError",
                      (error) =>
                        new SessionNotFoundError({
                          sessionID: error.sessionID,
                          message: `Session not found: ${error.sessionID}`,
                        }),
                    ),
                    Effect.catchTag(
                      "Session.PromptConflictError",
                      (error) =>
                        new ConflictError({
                          message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                          resource: error.messageID,
                        }),
                    ),
                  )
          const state = yield* GoalV2.get(db, ctx.params.sessionID)
          if (state === undefined) return yield* Effect.die("Goal state missing immediately after set")
          return { data: { goal: toApiState(state), ...(admitted === undefined ? {} : { admitted }) } }
        }),
      )
      .handle(
        "goal.clear",
        Effect.fn(function* (ctx) {
          yield* assertSession(ctx.params.sessionID)
          yield* GoalV2.clear(events, { sessionID: ctx.params.sessionID, reason: "manual" })
        }),
      )
  }),
)
