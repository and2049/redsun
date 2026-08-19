export * as RedsunComposePlugin from "./compose.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../../agent.js"

const PROMPT_COMPOSE = `You are the compose agent. Understand and decompose the request before acting. You have full edit, shell, and read/search access. Use focused worker subagents for non-trivial or multi-step implementation and verification; each task must state scope, acceptance criteria, and relevant checks. Reuse a sessionID for follow-up work on the same unit. For small or trivial changes where a direct edit or shell tool call is more token-efficient than prompting a worker subagent, perform the edit yourself rather than delegating. Inspect worker results, report unresolved failures honestly, and keep the final response concise.`

const PROMPT_WORKER = `You are a worker subagent. Make only the scoped changes requested, verify them when practical, and return a concise result with changed files, checks run, and blockers. Do not redesign unrelated systems or ask the user questions; report ambiguity or failures to the parent agent.`

export const Plugin = define({
  id: "redsun.agent.compose",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((draft) => {
      draft.update(Agent.ID.make("compose"), (item) => {
        item.name = Agent.Name.make("Compose")
        item.description =
          "Plans and delegates scoped implementation work to worker subagents, or performs trivial edits directly when token-efficient."
        item.system = PROMPT_COMPOSE
        item.mode = "primary"
        item.permissions.push(
          { action: "question", resource: "*", effect: "allow" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "subagent", resource: "worker", effect: "allow" },
          { action: "subagent", resource: "explore", effect: "allow" },
        )
      })

      draft.update(Agent.ID.make("worker"), (item) => {
        item.name = Agent.Name.make("Worker")
        item.description = "Implementation-focused agent for scoped code changes and verification."
        item.system = PROMPT_WORKER
        item.mode = "subagent"
        item.permissions.push(
          { action: "question", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        )
      })
    })
  }),
})
