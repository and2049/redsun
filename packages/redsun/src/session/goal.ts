import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ModelMessage } from "ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Provider } from "@/provider/provider"
import { Storage } from "@/storage/storage"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { customMessages } from "@/extension/runtime"
import { LLM } from "./llm"

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
    agent: Agent.Info
  }) => Effect.Effect<Verdict, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@redsun/SessionGoal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const llm = yield* LLM.Service

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
      const conversation = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      const custom = yield* Effect.promise(() => customMessages(input.sessionID))
      const user = input.messages.findLast((message) => message.info.role === "user")?.info
      if (!user || user.role !== "user") return yield* Effect.fail(new Error("Goal judge requires a user message"))

      const messages: ModelMessage[] = [
        ...conversation,
        ...(custom.length
          ? [{ role: "user", content: `<extension-context>\n${custom.join("\n\n")}\n</extension-context>` } as ModelMessage]
          : []),
        {
          role: "user",
          content: `Has this stopping condition been satisfied?\n\nCondition: ${input.condition}`,
        },
      ]
      let text = ""
      yield* llm
        .stream({
          user: { ...user, system: undefined },
          sessionID: input.sessionID,
          model: input.model,
          agent: { ...input.agent, prompt: JUDGE_SYSTEM, temperature: 0 },
          system: [],
          messages,
          tools: {},
          toolChoice: "none",
          internal: true,
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "text-delta") text += event.text
            }),
          ),
        )
      return parseVerdict(text)
    })

    return Service.of({ set, get, clear, bumpReact, publishVerdict, evaluate })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Storage.node, EventV2Bridge.node, LLM.node],
})

export function parseVerdict(input: string): Verdict {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  const value = fenced ?? (start >= 0 && end > start ? input.slice(start, end + 1) : input)
  return Schema.decodeUnknownSync(Verdict)(JSON.parse(value.trim()))
}

export * as Goal from "./goal"
