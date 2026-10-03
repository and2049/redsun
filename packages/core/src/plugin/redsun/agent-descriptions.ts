export * as RedsunAgentDescriptions from "./agent-descriptions.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../../agent.js"

// The subagent tool lists every available subagent's description on every request, so the
// built-in ones are kept to what the model needs to choose between them.
export const DESCRIPTIONS = {
  explore:
    "Read-only codebase search: find files by pattern, grep for keywords, or answer where/how questions about the code. Say quick, medium, or very thorough in the prompt.",
  general: "General-purpose agent for research and multi-step tasks; run several in parallel for independent work.",
} as const

export const Plugin = define({
  id: "redsun.agent.descriptions",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((draft) => {
      for (const [id, description] of Object.entries(DESCRIPTIONS))
        draft.update(Agent.ID.make(id), (item) => {
          item.description = description
        })
    })
  }),
})
