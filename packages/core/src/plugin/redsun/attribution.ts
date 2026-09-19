export * as RedsunAttribution from "./attribution.js"

import type { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"

/**
 * Opt-in commit attribution. Like Claude Code this is prompt-only: when `attribution.commit` is
 * set the model is told to end commit messages with a Co-authored-by trailer, and the identity
 * resolves on GitHub through the redsun-agent app's noreply address. The instruction is rebuilt per
 * request, so turning it off applies on the next turn; because the model imitates its own earlier
 * tool calls, a session that already carries the trailer receives a counter-instruction instead.
 */

export const DEFAULT_TRAILER =
  "Co-authored-by: redsun-agent[bot] <331402388+redsun-agent[bot]@users.noreply.github.com>"

const TRAILER_PATTERN = /co-authored-by:/i

export const trailer = (commit: boolean | string | undefined) =>
  commit === true ? DEFAULT_TRAILER : typeof commit === "string" && commit.trim() ? commit.trim() : undefined

export const instruction = (commit: boolean | string | undefined, messages: ReadonlyArray<Message>) => {
  const line = trailer(commit)
  if (line) return `When you create a git commit, end the commit message with this trailer on its own line:\n${line}`
  if (previouslyAttributed(messages))
    return "Commit attribution is disabled. Do not add a Co-authored-by trailer to commits unless the user asks for one."
  return undefined
}

const previouslyAttributed = (messages: ReadonlyArray<Message>) =>
  messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => {
        if (part.type === "tool-call") return TRAILER_PATTERN.test(JSON.stringify(part.input))
        if (part.type === "compaction") return TRAILER_PATTERN.test(part.text ?? "")
        return false
      }),
  )

export const Plugin = define({
  id: "redsun.attribution",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    for (const kind of ["context", "compaction", "generate"] as const)
      yield* ctx.session.hook(kind, (event) =>
        Effect.gen(function* () {
          const commit = Config.latest(yield* config.entries(), "attribution")?.commit
          const text = instruction(commit, event.messages)
          if (text) event.system.push({ type: "text", text })
        }),
      )
  }),
})
