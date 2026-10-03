export * as RedsunWorkerModel from "./worker-model.js"

import { Effect } from "effect"
import { Model } from "@opencode/schema/model"
import type { Model as ModelRegistry } from "../../model.js"
import type { KV } from "../../kv.js"

export interface Services {
  readonly kv: KV.Interface
  readonly models: ModelRegistry.Interface
}

const NO_PARENT_INHERIT = new Set<string>(["worker"])

export const inheritsParent = (agentID: string) => !NO_PARENT_INHERIT.has(agentID)

export const key = (sessionID: string) => `redsun.worker-model/${sessionID}`

export const unconfigured = (agentID: string) =>
  [
    `No model is configured for the "${agentID}" subagent, and it does not inherit the parent session's model.`,
    `Set one with \`agent.${agentID}.model\` in redsun.json (for example "anthropic/claude-sonnet-4#high"),`,
    `or set a session-scoped override.`,
  ].join(" ")

export const parse = (input: string) => {
  try {
    return Model.Ref.parse(input)
  } catch {
    return undefined
  }
}

/**
 * A session's choice. `chosen` without `model` is an explicit "use the configured default", which
 * a client's own default must not replace; an unchosen session takes the first client default.
 * `revision` rises with every write, so clients can order reads, replies and events.
 */
export interface Choice {
  readonly chosen: boolean
  readonly model?: string
  readonly revision: number
}

/** The session's stored choice, as written; it may name a model that is no longer available. */
export const stored = Effect.fn("RedsunWorkerModel.stored")(function* (kv: KV.Interface, sessionID: string) {
  return decode(yield* kv.get(key(sessionID)))
})

/** The value that stores `model` (or the configured default) as the write after `previous`. */
export const encode = (model: string | undefined, previous: Choice): KV.Value =>
  model === undefined ? { revision: previous.revision + 1 } : { model, revision: previous.revision + 1 }

const decode = (value: unknown): Choice => {
  if (typeof value === "string")
    return value.length > 0 ? { chosen: true, model: value, revision: 0 } : { chosen: false, revision: 0 }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { chosen: false, revision: 0 }
  const record = value as Record<string, unknown>
  const revision = typeof record.revision === "number" && Number.isSafeInteger(record.revision) ? record.revision : 0
  // Builds before the worker-model RPC stored `{ ref, seen }`, with `__clear__` for the default.
  const model = "ref" in record ? record.ref : record.model
  return typeof model === "string" && model.length > 0 && model !== "__clear__"
    ? { chosen: true, model, revision }
    : { chosen: true, revision }
}

export const sessionOverride = Effect.fn("RedsunWorkerModel.sessionOverride")(function* (
  services: Services,
  sessionID: string,
) {
  const ref = (yield* stored(services.kv, sessionID)).model
  if (ref === undefined) return undefined
  const parsed = parse(ref)
  if (parsed === undefined) {
    yield* Effect.logWarning("ignoring unparseable session worker model", { sessionID, stored: ref })
    return undefined
  }
  const model = yield* services.models.get(parsed.providerID, parsed.id)
  if (model === undefined) {
    yield* Effect.logWarning("ignoring unavailable session worker model", { sessionID, stored: ref })
    return undefined
  }
  return parsed
})

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
