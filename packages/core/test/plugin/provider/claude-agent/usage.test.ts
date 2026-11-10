import { describe, expect, test } from "bun:test"
import type { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { ClaudeUsageReport } from "@opencode/core/plugin/provider/claude-agent/usage"

// Captured from `claude -p /usage --output-format json` on Claude Code 2.1.319 (2026-11-09).
const LIVE = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 33% used · resets Nov 10 at 12:40am (America/Indianapolis)",
  "Current week (all models): 25% used · resets Nov 11 at 9am (America/Indianapolis)",
  "Current week (Fable): 26% used · resets Nov 11 at 9am (America/Indianapolis)",
  "",
  "What's contributing to your usage?",
  "Approximate · sessions on this machine only · shares overlap",
  "",
  "Last 24h · 48 requests · 2 sessions",
  "  98%  Turn off redsun when you don't need it",
  "  Top MCP servers: redsun 98%",
].join("\n")

describe("ClaudeUsageReport", () => {
  test("parses the session and all-model weekly windows and ignores per-model lines", () => {
    expect(ClaudeUsageReport.parse(LIVE)).toEqual({
      windows: [
        { id: "five-hour", label: "5-hour", usedPercent: 33, reset: "Nov 10 at 12:40am (America/Indianapolis)" },
        { id: "weekly", label: "Weekly", usedPercent: 25, reset: "Nov 11 at 9am (America/Indianapolis)" },
      ],
    })
  })

  test("reports unrecognized output as unavailable instead of inventing quotas", () => {
    const data = ClaudeUsageReport.parse("I can't see your usage data.")
    expect(data.windows).toEqual([])
    expect(data.message).toContain("did not report recognizable subscription limits")
  })

  test("sends /usage as a command the CLI answers locally, not as verbatim model input", () => {
    const io: ClaudeIO.Interface = {
      which: () => "/usr/bin/claude",
      env: () => ({}),
      spawn: () => {
        throw new Error("unused")
      },
    } as unknown as ClaudeIO.Interface
    const options = ClaudeUsageReport.options({
      executable: "/usr/bin/claude",
      io,
      connection: {},
      abortController: new AbortController(),
    })
    // The shared base turns verbatim prompts on; a verbatim `/usage` reaches the model as a billed turn.
    expect(options.verbatimPrompts).toBe(false)
    expect(options.maxTurns).toBe(1)
    expect(options.persistSession).toBe(false)
    expect(options.mcpServers).toEqual({})
    expect(options.tools).toEqual([])
  })
})
