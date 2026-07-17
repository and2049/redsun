import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { generateObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Storage } from "@/storage/storage"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { customMessages } from "@/extension/runtime"

export const Info = Schema.Struct({
  condition: Schema.String,
  react: NonNegativeInt,
})
export type Info = typeof Info.Type

export const Verdict = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
})
export type Verdict = typeof Verdict.Type

const JUDGE_SYSTEM = `You are evaluating a stop condition. Judge only from the conversation transcript.

Return JSON with {"ok":true,"reason":"evidence"} when the condition is satisfied, {"ok":false,"reason":"what is missing"} when work remains, or {"ok":false,"impossible":true,"reason":"why"} only when the condition genuinely cannot be achieved in this session. Always include a specific reason.`

const key = (sessionID: SessionID) => ["session_goal", sessionID]

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly bumpReact: (sessionID: SessionID) => Effect.Effect<number>
  readonly publishVerdict: (input: {
    sessionID: SessionID
    goal?: { condition: string }
    verdict: Verdict
    attempt: number
    messageID?: string
    error?: boolean
  }) => Effect.Effect<void>
  readonly evaluate: (input: {
    sessionID: SessionID
    condition: string
    messages: SessionV1.WithParts[]
    model: Provider.Model
  }) => Effect.Effect<Verdict, Provider.ModelNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@redsun/SessionGoal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service

    const get: Interface["get"] = Effect.fn("SessionGoal.get")(function* (sessionID) {
      return Option.getOrUndefined(yield* storage.read<Info>(key(sessionID)).pipe(Effect.option))
    })

    const publish = (input: Parameters<Interface["publishVerdict"]>[0] | { sessionID: SessionID; goal?: { condition: string } }) =>
      events.publish(SessionV1.Event.GoalUpdated, input)

    const set: Interface["set"] = Effect.fn("SessionGoal.set")(function* (sessionID, condition) {
      yield* storage.write(key(sessionID), { condition, react: 0 } satisfies Info).pipe(Effect.orDie)
      yield* publish({ sessionID, goal: { condition } })
    })

    const clear: Interface["clear"] = Effect.fn("SessionGoal.clear")(function* (sessionID) {
      yield* storage.remove(key(sessionID)).pipe(Effect.orDie)
      yield* publish({ sessionID })
    })

    const bumpReact: Interface["bumpReact"] = Effect.fn("SessionGoal.bumpReact")(function* (sessionID) {
      const current = yield* get(sessionID)
      if (!current) return 0
      const next = current.react + 1
      yield* storage.write(key(sessionID), { ...current, react: next }).pipe(Effect.orDie)
      return next
    })

    const publishVerdict: Interface["publishVerdict"] = Effect.fn("SessionGoal.publishVerdict")(function* (input) {
      yield* publish(input)
    })

    const evaluate: Interface["evaluate"] = Effect.fn("SessionGoal.evaluate")(function* (input) {
      const language = yield* provider.getLanguage(input.model)
      const conversation = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      const custom = yield* Effect.promise(() => customMessages(input.sessionID))
      const result = yield* Effect.promise(() =>
        generateObject({
          model: language,
          temperature: 0,
          messages: [
            { role: "system", content: JUDGE_SYSTEM } as ModelMessage,
            ...conversation,
            ...(custom.length
              ? [{ role: "user", content: `<extension-context>\n${custom.join("\n\n")}\n</extension-context>` } as ModelMessage]
              : []),
            {
              role: "user",
              content: `Has this stopping condition been satisfied?\n\nCondition: ${input.condition}`,
            } as ModelMessage,
          ],
          schema: Object.assign(Schema.toStandardSchemaV1(Verdict), Schema.toStandardJSONSchemaV1(Verdict)),
        }).then((result) => Schema.decodeUnknownSync(Verdict)(result.object)),
      )
      return result
    })

    return Service.of({ set, get, clear, bumpReact, publishVerdict, evaluate })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Storage.node, Provider.node, EventV2Bridge.node],
})

export * as Goal from "./goal"
