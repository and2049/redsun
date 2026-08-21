export * as PlanPlugin from "./plan.js"

import { Message, ToolFailure } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Global } from "@opencode-ai/util/global"
import { Effect, Stream } from "effect"
import path from "node:path"
import { Agent } from "../agent.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { SessionEvent } from "../session/event.js"

const plan = Agent.ID.make("plan")

const planDirectory = (location: Location.Interface) =>
  location.vcs ? path.join(location.project.directory, ".redsun", "plans") : path.join(Global.Path.data, "plans")

const enter = (directory: string) => `<system-reminder>
You are in Plan mode. You may optionally create or update plan documents in:
${directory}

Do not modify any other files, run shell commands, or ask a subagent to do any of that.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const plans = planDirectory(location)
    const enterReminder = enter(plans)

    yield* ctx.agent.transform((draft) => {
      draft.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Read-only agent for exploring the codebase and planning work before implementation."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        item.permissions.push({ action: "subagent", resource: "*", effect: "deny" })
        item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
        item.permissions.push({ action: "edit", resource: path.join(plans, "*"), effect: "allow" })
        item.permissions.push({ action: "external_directory", resource: path.join(plans, "*"), effect: "allow" })
      })
    })

    // REDSUN: a delegated Claude Code session has Bash blocked by the SDK's own
    // permissionMode: "plan"; a native model had no equivalent, so plan mode was
    // read-only in name only. Refused here rather than as a permission deny because
    // the shell scanner yields no resource for some inputs, and a rule that is never
    // asserted is not a restriction.
    yield* ctx.tool.hook("execute.before", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.tool === "shell")
        return new ToolFailure({
          message:
            "Cannot use shell in Plan mode. You are in a read-only mode and must not run commands. Use read, grep, and glob to investigate; if you need to run something, tell the user to switch agents.",
        })
      return Effect.void
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.status !== "error") return Effect.void
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${plans}`,
      })
      return Effect.void
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    yield* ctx.session.hook("context", (event) => {
      const reminder = lastReminder(event.messages, enterReminder)
      const missing = event.agent === plan && reminder !== enterReminder
      const stale = event.agent !== plan && reminder === enterReminder
      const text = missing ? enterReminder : stale ? leave : undefined
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
        const text = switchReminder(event, enterReminder)
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

function switchReminder(
  event: SessionEvent.Created | SessionEvent.AgentSelected,
  enterReminder: string,
): string | undefined {
  if (event.type === "session.created") {
    if (event.data.agent !== plan) return undefined
    return enterReminder
  }
  if (event.data.agent === event.data.previous) return undefined
  if (event.data.agent === plan) return enterReminder
  if (event.data.previous === plan) return leave
  return undefined
}

function lastReminder(messages: ReadonlyArray<Message>, enterReminder: string) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    return part.text === enterReminder || part.text === leave ? part.text : found
  }, undefined)
}
