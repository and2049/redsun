import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Usage } from "@opencode/plugin/usage"
import type { ClaudeCodeSessions } from "./sessions.js"

/** Only the two account-wide windows; model-specific weekly limits are separate from these. */
export function parseClaudeUsage(text: string): Usage.Data {
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

export async function readClaudeUsage(
  createQuery: ClaudeCodeSessions.CreateQuery,
  options: Options,
  signal: AbortSignal,
): Promise<Usage.Data> {
  signal.throwIfAborted()
  const abortController = new AbortController()
  const query = createQuery({
    prompt: "/usage",
    options: {
      ...options,
      abortController,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
      settings: { disableAllHooks: true },
    },
  })
  const abort = () => {
    abortController.abort()
    query.close()
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    let output = ""
    for await (const message of query) {
      if (message.type === "assistant") {
        for (const part of message.message.content) if (part.type === "text") output += part.text + "\n"
      }
      if (message.type !== "result") continue
      if (message.is_error) throw new Error("Claude usage command failed")
      if (message.subtype === "success" && message.result) output = message.result
      break
    }
    signal.throwIfAborted()
    return parseClaudeUsage(output)
  } finally {
    signal.removeEventListener("abort", abort)
    query.close()
  }
}
