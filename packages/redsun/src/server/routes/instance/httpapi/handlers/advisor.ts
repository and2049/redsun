import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Config as ConfigV2 } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Advisor, advisorConfigFromEntries } from "@/advisor/advisor"
import { GoalApi } from "../groups/goal"

export const advisorHandlers = HttpApiBuilder.group(GoalApi, "redsun.advisor", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const db = (yield* Database.Service).db

    return handlers.handle(
      "advisor.get",
      Effect.fn(function* (ctx) {
        yield* sessions.get(ctx.params.sessionID).pipe(
          Effect.catchTag(
            "Session.NotFoundError",
            (error) =>
              new SessionNotFoundError({
                sessionID: error.sessionID,
                message: `Session not found: ${error.sessionID}`,
              }),
          ),
        )
        // The session-location middleware provides the Location-scoped v2 config.
        const cfg = advisorConfigFromEntries(yield* (yield* ConfigV2.Service).entries())
        const advisories = yield* Advisor.list(db, ctx.params.sessionID)
        return {
          data: {
            enabled: cfg?.enabled === true,
            advisories: advisories.map((advisory) => ({
              timestamp: advisory.timestamp,
              severity: advisory.severity,
              note: advisory.note,
              ...(advisory.judgedMessageID === undefined ? {} : { judgedMessageID: advisory.judgedMessageID }),
              ...(advisory.model === undefined ? {} : { model: advisory.model }),
            })),
          },
        }
      }),
    )
  }),
)
