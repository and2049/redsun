export * as RedsunWorkerModel from "./worker-model.js"

import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import type { Catalog } from "../../catalog.js"
import type { KV } from "../../kv.js"
import type { SessionStore } from "../../session/store.js"

export interface Services {
  readonly kv: KV.Interface
  readonly catalog: Catalog.Interface
  readonly store: SessionStore.Interface
}

const NO_PARENT_INHERIT = new Set<string>(["worker"])

export const inheritsParent = (agentID: string) => !NO_PARENT_INHERIT.has(agentID)

export const key = (sessionID: string) => `redsun.worker-model/${sessionID}`

export const METADATA_KEY = "redsun.worker-model"

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
  readonly seen?: string
}

const readStored = (value: unknown): Stored | undefined => {
  if (typeof value === "string") return value.length > 0 ? { ref: value } : undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { ref, seen } = value as Record<string, unknown>
  if (typeof ref !== "string" || ref.length === 0) return undefined
  return typeof seen === "string" ? { ref, seen } : { ref }
}

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

export const sessionOverride = Effect.fn("RedsunWorkerModel.sessionOverride")(function* (
  services: Services,
  sessionID: string,
) {
  const stored = readStored(yield* services.kv.get(key(sessionID)))
  const choice = yield* latestChoice(services, sessionID)

  let ref = stored?.ref
  if (choice !== undefined && choice.messageID !== stored?.seen) {
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
