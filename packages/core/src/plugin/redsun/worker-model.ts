export * as RedsunWorkerModel from "./worker-model.js"

import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import type { Catalog } from "../../catalog.js"
import type { KV } from "../../kv.js"
import type { SessionStore } from "../../session/store.js"

// A tool's execute effect must have `never` requirements, so callers yield these
// at plugin scope and pass them in rather than letting this module yield them.
export interface Services {
  readonly kv: KV.Interface
  readonly catalog: Catalog.Interface
  readonly store: SessionStore.Interface
}

// Agents that must never fall back to the parent session's model.
const NO_PARENT_INHERIT = new Set<string>(["worker"])

export const inheritsParent = (agentID: string) => !NO_PARENT_INHERIT.has(agentID)

export const key = (sessionID: string) => `redsun.worker-model/${sessionID}`

/** The user-message metadata key the TUI stamps its choice on. */
export const METADATA_KEY = "redsun.worker-model"

/** The value that means "stop overriding and use whatever is configured". */
export const CLEAR = "__clear__"

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

interface Stored {
  readonly ref: string
  /** Id of the user message this value came from, when it came from one. */
  readonly seen?: string
}

/** Accepts the bare string earlier builds wrote, as well as the current shape. */
const readStored = (value: unknown): Stored | undefined => {
  if (typeof value === "string") return value.length > 0 ? { ref: value } : undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { ref, seen } = value as Record<string, unknown>
  if (typeof ref !== "string" || ref.length === 0) return undefined
  return typeof seen === "string" ? { ref, seen } : { ref }
}

/** The newest user message carrying a worker-model choice, if the history holds one. */
const latestChoice = Effect.fn("RedsunWorkerModel.latestChoice")(function* (services: Services, sessionID: string) {
  const messages = yield* services.store.context(sessionID as never).pipe(Effect.orElseSucceed(() => []))
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.type !== "user") continue
    const value = message.metadata?.[METADATA_KEY]
    if (typeof value !== "string" || value.length === 0) continue
    return { ref: value, messageID: message.id as string }
  }
  return undefined
})

/**
 * The session-scoped override, or undefined when unset, cleared, unparseable,
 * or naming a model the catalog does not have. An unavailable override warns
 * and falls through rather than failing, matching V1.
 */
export const sessionOverride = Effect.fn("RedsunWorkerModel.sessionOverride")(function* (
  services: Services,
  sessionID: string,
) {
  const stored = readStored(yield* services.kv.get(key(sessionID)))
  const choice = yield* latestChoice(services, sessionID)

  let ref = stored?.ref
  if (choice !== undefined && choice.messageID !== stored?.seen) {
    // A prompt the stored value has not seen: the user picked since, so it wins
    // and becomes the stored value.
    ref = choice.ref
    yield* services.kv.set(key(sessionID), { ref, seen: choice.messageID })
  }

  if (ref === undefined || ref.length === 0 || ref === CLEAR) return undefined
  const parsed = parse(ref)
  if (parsed === undefined) {
    yield* Effect.logWarning("ignoring unparseable session worker model", { sessionID, stored: ref })
    return undefined
  }
  const model = yield* services.catalog.model.get(parsed.providerID, parsed.id)
  if (model === undefined) {
    yield* Effect.logWarning("ignoring unavailable session worker model", { sessionID, stored: ref })
    return undefined
  }
  return parsed
})

/**
 * Records a choice made mid-turn (the `worker_model` tool's form).
 *
 * It is stamped against the newest user message so the next read does not treat
 * that message's own metadata as newer and undo it; only a *later* prompt does.
 */
export const setSessionOverride = Effect.fn("RedsunWorkerModel.setSessionOverride")(function* (
  services: Services,
  sessionID: string,
  ref: string,
) {
  const choice = yield* latestChoice(services, sessionID)
  yield* services.kv.set(key(sessionID), choice === undefined ? { ref } : { ref, seen: choice.messageID })
})

export const clearSessionOverride = (services: Services, sessionID: string) =>
  setSessionOverride(services, sessionID, CLEAR)

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
