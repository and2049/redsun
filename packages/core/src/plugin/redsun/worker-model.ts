// REDSUN: worker model + variant resolution for compose delegation.
//
// Upstream's subagent tool picks `agent.model ?? parent.model`. Two redsun
// contracts sit on top of that:
//
//   1. A session-scoped override, so a worker model chosen for one session beats
//      the configured default without editing config. V1 kept this on a session
//      table column; here it is a durable KV entry, which needs no schema change.
//   2. Fail-closed workers. Inheriting `parent.model` silently promotes a cheap
//      delegation onto an expensive planner model, so a worker with no resolved
//      model refuses instead.
//
// The variant rides along inside `Model.Ref` (`provider/model#variant`), so V1's
// separate `task_router.worker_variant` key has no counterpart here.
export * as RedsunWorkerModel from "./worker-model.js"

import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import type { Catalog } from "../../catalog.js"
import type { KV } from "../../kv.js"

// A tool's execute effect must have `never` requirements, so callers yield these
// at plugin scope and pass them in rather than letting this module yield them.
export interface Services {
  readonly kv: KV.Interface
  readonly catalog: Catalog.Interface
}

// Agents that must never fall back to the parent session's model.
const NO_PARENT_INHERIT = new Set<string>(["worker"])

export const inheritsParent = (agentID: string) => !NO_PARENT_INHERIT.has(agentID)

export const key = (sessionID: string) => `redsun.worker-model/${sessionID}`

export const unconfigured = (agentID: string) =>
  [
    `No model is configured for the "${agentID}" subagent, and it does not inherit the parent session's model.`,
    `Set one with \`agent.${agentID}.model\` in redsun.json (for example "anthropic/claude-sonnet-4#high"),`,
    `or set a session-scoped override.`,
  ].join(" ")

const parse = (input: string) => {
  try {
    return Model.Ref.parse(input)
  } catch {
    return undefined
  }
}

/**
 * The session-scoped override, or undefined when unset, unparseable, or naming a
 * model the catalog does not have. An unavailable override warns and falls
 * through rather than failing, matching V1.
 */
export const sessionOverride = Effect.fn("RedsunWorkerModel.sessionOverride")(function* (
  services: Services,
  sessionID: string,
) {
  const stored = yield* services.kv.get(key(sessionID))
  if (typeof stored !== "string" || stored.length === 0) return undefined
  const ref = parse(stored)
  if (ref === undefined) {
    yield* Effect.logWarning("ignoring unparseable session worker model", { sessionID, stored })
    return undefined
  }
  const model = yield* services.catalog.model.get(ref.providerID, ref.id)
  if (model === undefined) {
    yield* Effect.logWarning("ignoring unavailable session worker model", { sessionID, stored })
    return undefined
  }
  return ref
})

export const setSessionOverride = (services: Services, sessionID: string, ref: string) =>
  services.kv.set(key(sessionID), ref)

export const clearSessionOverride = (services: Services, sessionID: string) => services.kv.remove(key(sessionID))

/**
 * Resolve the model a subagent should run with.
 *
 * Precedence: session override, then the agent's configured model, then the
 * parent session's model for agents that may inherit it. Returns undefined when
 * a fail-closed agent has nothing configured.
 */
export const resolve = Effect.fn("RedsunWorkerModel.resolve")(function* (input: {
  readonly services: Services
  readonly agentID: string
  readonly agentModel: Model.Ref | undefined
  readonly parentModel: Model.Ref | undefined
  readonly sessionID: string
}) {
  const override = yield* sessionOverride(input.services, input.sessionID)
  if (override !== undefined) return override
  if (input.agentModel !== undefined) return input.agentModel
  return inheritsParent(input.agentID) ? input.parentModel : undefined
})
