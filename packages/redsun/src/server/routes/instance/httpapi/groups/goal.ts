import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { RedsunGoalEvent } from "@opencode-ai/schema/redsun-goal-event"
import { Session } from "@opencode-ai/schema/session"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { ConflictError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@opencode-ai/protocol/middleware/schema-error"
import { SessionLocationMiddleware } from "@opencode-ai/server/middleware/session-location"

/**
 * Redsun-owned goal endpoints for v2 sessions. Lives beside the upstream v2 `/api/*`
 * tree instead of forking `@opencode-ai/protocol`; goal state itself is durable in the
 * `redsun.session.goal.*` event family.
 */

export const GoalState = Schema.Struct({
  condition: Schema.String,
  budget: RedsunGoalEvent.Budget.pipe(Schema.optional),
  attempts: NonNegativeInt,
  lastVerdict: Schema.Struct({
    ok: Schema.Boolean,
    impossible: Schema.Boolean.pipe(Schema.optional),
    reason: Schema.String,
    attempt: NonNegativeInt,
    judgedMessageID: Schema.String.pipe(Schema.optional),
    error: Schema.Boolean.pipe(Schema.optional),
  }).pipe(Schema.optional),
}).annotate({ identifier: "RedsunGoalState" })
export type GoalState = typeof GoalState.Type

export const GoalApi = HttpApi.make("redsun-goal")
  .add(
    HttpApiGroup.make("redsun.goal")
      .add(
        HttpApiEndpoint.get("goal.get", "/api/session/:sessionID/goal", {
          params: { sessionID: Session.ID },
          success: Schema.Struct({ data: Schema.Struct({ goal: GoalState.pipe(Schema.optional) }) }).annotate({
            identifier: "RedsunGoalResponse",
          }),
          error: SessionNotFoundError,
        })
          .middleware(SessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "redsun.session.goal.get",
              summary: "Get session goal",
              description: "Retrieve the durable goal stop condition for a v2 session, if one is active.",
            }),
          ),
      )
      .add(
        HttpApiEndpoint.post("goal.set", "/api/session/:sessionID/goal", {
          params: { sessionID: Session.ID },
          payload: Schema.Struct({
            condition: Schema.String,
            budget: RedsunGoalEvent.Budget.pipe(Schema.optional),
            prompt: Schema.Boolean.pipe(Schema.optional).annotate({
              description:
                "When true (default), the condition text is also admitted as a real steering prompt so the agent starts working toward the goal immediately.",
            }),
          }),
          success: Schema.Struct({
            data: Schema.Struct({
              goal: GoalState,
              admitted: SessionInput.Admitted.pipe(Schema.optional),
            }),
          }).annotate({ identifier: "RedsunGoalSetResponse" }),
          error: [SessionNotFoundError, ConflictError],
        })
          .middleware(SessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "redsun.session.goal.set",
              summary: "Set session goal",
              description:
                "Durably set the goal stop condition for a v2 session. The session keeps working until an independent judge confirms the condition is satisfied, impossible, or the attempt cap is reached.",
            }),
          ),
      )
      .add(
        HttpApiEndpoint.delete("goal.clear", "/api/session/:sessionID/goal", {
          params: { sessionID: Session.ID },
          success: HttpApiSchema.NoContent,
          error: SessionNotFoundError,
        })
          .middleware(SessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "redsun.session.goal.clear",
              summary: "Clear session goal",
              description: "Clear the goal stop condition for a v2 session.",
            }),
          ),
      ),
  )
  .middleware(Authorization)
  .middleware(SchemaErrorMiddleware)
