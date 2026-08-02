export * as Advisor from "./advisor"

import { LLM, LLMClient, SystemPart } from "@opencode-ai/llm"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RedsunAdvisorEvent } from "@opencode-ai/schema/redsun-advisor-event"
import { Cause, Context, DateTime, Effect, Layer, Queue, Schema, Stream } from "effect"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Config as ConfigV2 } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"

/**
 * Watchdog advisor for v2 sessions (oh-my-pi inspired). A second model reviews each
 * completed drain with its own context and no tools, then either stays silent, records
 * an aside the agent sees on its next turn (durable synthetic message), or interrupts
 * with a steering prompt. Disabled unless `advisor.enabled` is set. Reviews are
 * best-effort: failures are logged and never affect the session.
 */

const ADVISOR_SYSTEM = `You are a watchdog advisor reviewing another agent's coding session after a completed turn. Judge only from the transcript.

Return JSON: {"severity":"none"} when no intervention is warranted (the default), {"severity":"aside","note":"..."} for guidance the agent should see before its next turn, or {"severity":"interrupt","note":"..."} only for serious problems that must be corrected before work continues (destructive or unsafe actions, a clearly wrong direction, violating explicit user instructions). Notes must be terse and specific. Prefer "none" - do not nitpick style or restate what the agent already knows.`

const REVIEW_QUESTION = "Review the transcript above. Does the last completed turn warrant an advisory?"

const MAX_CONTEXT_MESSAGES = 40
const QUEUE_CAPACITY = 16
const MAX_TRACKED_PROMPTS = 256

export const Advisory = Schema.Struct({
  severity: Schema.Literals(["none", "aside", "interrupt"]),
  note: Schema.optional(Schema.String),
})
export type Advisory = typeof Advisory.Type

export type AdvisorConfig = NonNullable<ConfigV2.Info["advisor"]>

/** Last document wins per field, matching v2 config precedence for scalar sections. */
export const advisorConfigFromEntries = (entries: ReadonlyArray<ConfigV2.Entry>): AdvisorConfig | undefined => {
  let merged: AdvisorConfig | undefined
  for (const entry of entries) {
    if (entry.type !== "document") continue
    const advisor = entry.info.advisor
    if (advisor !== undefined) merged = { ...merged, ...advisor }
  }
  return merged
}

export function parseAdvisory(input: string): Advisory {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  const value = fenced ?? (start >= 0 && end > start ? input.slice(start, end + 1) : input)
  return Schema.decodeUnknownSync(Advisory)(JSON.parse(value.trim()))
}

const GUIDANCE_FILES = ["WATCHDOG.md", "ADVISOR.md"]
const MAX_GUIDANCE_BYTES = 16_384
const MAX_GUIDANCE_WALK = 16

/**
 * Advisor-only guidance discovered by walking up from the session directory
 * (`WATCHDOG.md` beats `ADVISOR.md`, nearest directory wins). Never surfaces to the
 * session model - only the advisor reads it.
 */
const loadGuidanceFile = (directory: string) =>
  Effect.promise(async () => {
    let current = directory
    for (let depth = 0; depth < MAX_GUIDANCE_WALK; depth++) {
      for (const name of GUIDANCE_FILES) {
        const text = await readFile(join(current, name), "utf8").catch(() => undefined)
        if (text !== undefined && text.trim().length > 0) return text.slice(0, MAX_GUIDANCE_BYTES)
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
    return undefined
  })

/** Newest-first advisories folded from the durable event log. */
export const list = Effect.fn("Advisor.list")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  limit = 20,
) {
  const issued: RedsunAdvisorEvent.Issued["data"][] = []
  let after = -1
  while (true) {
    const page = yield* EventV2.readAggregate(db, {
      aggregateID: sessionID,
      after,
      limit: 200,
      manifest: RedsunAdvisorEvent.Manifest,
    })
    for (const event of page.events) {
      after = event.durable?.seq ?? after
      issued.push(event.data)
    }
    if (!page.hasMore) break
  }
  return issued.slice(-limit).reverse()
})

const parseModelRef = (route: string | undefined) => {
  if (!route) return undefined
  const separator = route.indexOf("/")
  if (separator <= 0 || separator === route.length - 1) return undefined
  return {
    providerID: ProviderV2.ID.make(route.slice(0, separator)),
    id: ModelV2.ID.make(route.slice(separator + 1)),
  }
}

export interface Interface {
  /** Review one completed drain. Used by the daemon; exposed for tests. */
  readonly review: (input: {
    readonly sessionID: SessionSchema.ID
    readonly promptMessageID: SessionMessage.ID
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redsun/Advisor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const sessions = yield* SessionV2.Service
    const locations = yield* LocationServiceMap.Service
    const llm = yield* LLMClient.Service

    // Steering prompts this advisor authored; their settlements must not re-trigger a review.
    const advisorPrompts = new Set<string>()
    // Sessions on cooldown: number of settlements to skip before advising again.
    const cooldown = new Map<string, number>()

    const review: Interface["review"] = (input) =>
      Effect.gen(function* () {
        if (advisorPrompts.delete(input.promptMessageID)) return
        const session = yield* store.get(input.sessionID)
        if (!session) return
        const located = locations.get(session.location)
        const cfg = advisorConfigFromEntries(
          yield* ConfigV2.Service.use((config) => config.entries()).pipe(Effect.provide(located)),
        )
        if (cfg?.enabled !== true) return
        const remaining = cooldown.get(input.sessionID) ?? 0
        if (remaining > 0) {
          cooldown.set(input.sessionID, remaining - 1)
          return
        }

        const context = (yield* store.context(input.sessionID)).slice(-MAX_CONTEXT_MESSAGES)
        if (context.length === 0) return
        const judgedMessageID = context.findLast((message) => message.type === "assistant")?.id

        const override = parseModelRef(cfg.model)
        const model = yield* SessionRunnerModel.Service.use((models) =>
          models.resolve(override === undefined ? session : { ...session, model: override }),
        ).pipe(Effect.provide(located))

        const guidance = cfg.guidance ?? (yield* loadGuidanceFile(session.location.directory))
        const request = LLM.request({
          model,
          system: [
            SystemPart.make(guidance ? `${ADVISOR_SYSTEM}\n\n<guidance>\n${guidance}\n</guidance>` : ADVISOR_SYSTEM),
          ],
          messages: toLLMMessages(context, model),
          prompt: REVIEW_QUESTION,
          tools: [],
          toolChoice: "none",
          generation: { temperature: 0 },
        })
        const response = yield* llm.generate(request)
        const advisory = yield* Effect.try({ try: () => parseAdvisory(response.text), catch: (error) => error })
        if (advisory.severity === "none" || advisory.note === undefined || advisory.note.length === 0) return
        const severity = cfg.mode === "aside-only" && advisory.severity === "interrupt" ? "aside" : advisory.severity

        yield* events.publish(RedsunAdvisorEvent.Issued, {
          timestamp: yield* DateTime.now,
          sessionID: input.sessionID,
          severity,
          note: advisory.note,
          ...(judgedMessageID === undefined ? {} : { judgedMessageID }),
          model: `${model.provider}/${model.id}`,
        })
        cooldown.set(input.sessionID, Math.max(0, cfg.cooldownTurns ?? 1))

        if (severity === "interrupt") {
          const admitted = yield* sessions.prompt({
            sessionID: input.sessionID,
            prompt: { text: `[advisor] ${advisory.note}` },
            delivery: "steer",
          })
          advisorPrompts.add(admitted.id)
          if (advisorPrompts.size > MAX_TRACKED_PROMPTS) {
            const oldest = advisorPrompts.values().next().value
            if (oldest !== undefined) advisorPrompts.delete(oldest)
          }
          return
        }
        yield* events.publish(SessionEvent.Synthetic, {
          timestamp: yield* DateTime.now,
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          text: `[advisor] ${advisory.note}`,
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("advisor review failed", { error: String(Cause.squash(cause)) }),
        ),
      )

    const queue = yield* Queue.dropping<{ sessionID: SessionSchema.ID; promptMessageID: SessionMessage.ID }>(
      QUEUE_CAPACITY,
    )
    yield* events
      .subscribe(SessionEvent.Settled)
      .pipe(
        Stream.filter((event) => event.data.outcome === "completed"),
        Stream.runForEach((event) =>
          Queue.offer(queue, { sessionID: event.data.sessionID, promptMessageID: event.data.messageID }),
        ),
        Effect.forkScoped,
      )
    yield* Queue.take(queue).pipe(Effect.flatMap(review), Effect.forever, Effect.forkScoped)

    return Service.of({ review })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2.node, SessionStore.node, SessionV2.node, LocationServiceMap.node, llmClient],
})
