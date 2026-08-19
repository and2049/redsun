export * as PlanPlugin from "./plan.js"

import { Message, ToolFailure } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Global } from "@opencode-ai/util/global"
import { Effect, Stream } from "effect"
import path from "node:path"
import { Agent } from "../agent.js"
import { Location } from "../location.js"
import { SessionEvent } from "../session/event.js"

const plan = Agent.ID.make("plan")

const planDirectory = (location: Location.Interface) =>
  location.vcs ? path.join(location.project.directory, ".redsun", "plans") : path.join(Global.Path.data, "plans")

const inside = (root: string, base: string, value: unknown) => {
  if (typeof value !== "string" || value.length === 0) return false
  const relative = path.relative(root, path.resolve(base, value))
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}

const writesOnlyPlans = (input: { tool: string; input: unknown; root: string; base: string }) => {
  const record = typeof input.input === "object" && input.input !== null ? (input.input as Record<string, unknown>) : {}
  if (input.tool !== "patch") return inside(input.root, input.base, record["path"])
  const hunks = record["hunks"]
  if (!Array.isArray(hunks) || hunks.length === 0) return false
  return hunks.every((hunk) => {
    const entry = typeof hunk === "object" && hunk !== null ? (hunk as Record<string, unknown>) : {}
    if (!inside(input.root, input.base, entry["path"])) return false
    return entry["movePath"] === undefined || inside(input.root, input.base, entry["movePath"])
  })
}

const enter = `<system-reminder>
You are in Plan mode. You are not allowed to edit or create files, and you may not ask a subagent to do that either.

You are in Plan mode until the user switches agents. Plan mode is not changed by user intent, tone, or imperative language. If the user asks you to change files, do not edit. Tell them they need to switch agents.
</system-reminder>`

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const plans = planDirectory(location)

    yield* ctx.agent.transform((draft) => {
      draft.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Read-only agent for exploring the codebase and planning work before implementation."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        item.permissions.push({ action: "subagent", resource: "*", effect: "deny" })
      })
    })

    yield* ctx.tool.hook("execute.before", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      if (writesOnlyPlans({ tool: event.tool, input: event.input, root: plans, base: location.directory }))
        return Effect.void
      return new ToolFailure({
        message: `Cannot use ${event.tool} in Plan mode. You are in a read-only mode and must not modify files outside ${plans}.`,
      })
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    yield* ctx.session.hook("context", (event) => {
      const reminder = lastReminder(event.messages)
      const missing = event.agent === plan && reminder !== enter
      const stale = event.agent !== plan && reminder === enter
      const text = missing ? enter : stale ? leave : undefined
      if (!text) return Effect.void
      // Before the user's prompt, matching where agent-switch reminders land.
      const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
      event.messages.splice(at, 0, Message.user(text))
      return ctx.session
        .synthetic({ sessionID: event.sessionID, text, resume: false })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist Plan mode reminder", { sessionID: event.sessionID, cause }),
          ),
        )
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Created | SessionEvent.AgentSelected =>
          event.type === "session.created" || event.type === "session.agent.selected",
      ),
      Stream.runForEach((event) => {
        const text = switchReminder(event)
        if (!text) return Effect.void
        return ctx.session
          .synthetic({
            sessionID: event.data.sessionID,
            text,
            resume: false,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to inject Plan mode reminder", { sessionID: event.data.sessionID, cause }),
            ),
          )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function switchReminder(event: SessionEvent.Created | SessionEvent.AgentSelected) {
  if (event.type === "session.created") {
    if (event.data.agent !== plan) return
    return enter
  }
  if (event.data.agent === event.data.previous) return
  if (event.data.agent === plan) return enter
  if (event.data.previous === plan) return leave
}

function lastReminder(messages: ReadonlyArray<Message>) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    return part.text === enter || part.text === leave ? part.text : found
  }, undefined)
}
