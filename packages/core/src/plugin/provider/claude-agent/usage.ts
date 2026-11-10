export * as ClaudeUsageReport from "./usage.js"

// REDSUN: Claude plan quotas for `/usage`, beside the ChatGPT and Kiro collectors. Claude Code answers
// `/usage` locally (no model request); the reply is human-readable plan-window usage.

import type { Context } from "@opencode/plugin/effect/plugin"
import { registerUsage } from "@opencode/plugin/effect/usage"
import type { Usage } from "@opencode/plugin/usage"
import { Effect } from "effect"
import type { ClaudeIO } from "./claude/io.js"
import { ClaudeQueryOptions } from "./claude/query-options.js"
import { ClaudeSDK } from "./claude/sdk.js"
import { ClaudeIntegration } from "./integration.js"
import { ClaudeProvider } from "./provider.js"

/** Only the two account-wide windows; model-specific weekly limits are separate from these. */
export function parse(text: string): Usage.Data {
  const windows: Usage.Window[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^Current (session|week(?: \(all models\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*[·•]\s*resets\s+(.+))?$/i)
    if (!match) continue
    const weekly = match[1]!.toLowerCase().startsWith("week")
    windows.push({
      id: weekly ? "weekly" : "five-hour",
      label: weekly ? "Weekly" : "5-hour",
      usedPercent: Number(match[2]),
      ...(match[3] ? { reset: match[3] } : {}),
    })
  }
  return {
    windows,
    ...(windows.length
      ? {}
      : {
          message:
            "Claude Code did not report recognizable subscription limits. Check /usage in Claude Code or update the CLI.",
        }),
  }
}

/**
 * Options for the isolated one-shot `/usage` query: no tools, no MCP, no hooks, nothing persisted.
 * The shared base sends prompts verbatim so chat text is never parsed as a slash command; here the
 * prompt *is* the command, and verbatim delivery would hand `/usage` to the model as a billed turn
 * that answers without any quota data.
 */
export function options(input: {
  executable: string
  io: ClaudeIO.Interface
  connection: Readonly<Record<string, string>>
  abortController: AbortController
}) {
  return {
    ...ClaudeQueryOptions.base(input),
    abortController: input.abortController,
    verbatimPrompts: false,
    mcpServers: {},
    persistSession: false,
    maxTurns: 1,
  }
}

/** An isolated one-shot `/usage` query, handled locally by the CLI without a model request. */
export async function read(
  io: ClaudeIO.Interface,
  connection: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Usage.Data> {
  signal.throwIfAborted()
  const executable = io.which()
  if (!executable) throw new Error("Claude Code is not installed")
  const { query } = await ClaudeSDK.load()
  const abortController = new AbortController()
  const session = query({ prompt: "/usage", options: options({ executable, io, connection, abortController }) })
  const abort = () => {
    abortController.abort()
    session.close()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    let output = ""
    for await (const message of session) {
      if (message.type === "assistant") {
        for (const part of message.message.content) if (part.type === "text") output += part.text + "\n"
      }
      if (message.type !== "result") continue
      if (message.is_error) throw new Error("Claude usage command failed")
      if (message.subtype === "success" && message.result) output = message.result
      break
    }
    signal.throwIfAborted()
    return parse(output)
  } finally {
    signal.removeEventListener("abort", abort)
    session.close()
  }
}

export const register = Effect.fn("ClaudeUsageReport.register")(function* (ctx: Context, io: ClaudeIO.Interface) {
  const connection = Effect.runPromiseWith(yield* Effect.context<never>())
  yield* registerUsage(ctx, {
    providerID: ClaudeProvider.ID,
    type: "external",
    methods: [ClaudeIntegration.METHOD_ID],
    read: async (_credential, signal) => read(io, await connection(ClaudeProvider.connection(ctx)), signal),
  })
})
