import { expect, test } from "bun:test"
import { parseClaudeUsage, readClaudeUsage } from "../src/usage.js"
import type { ClaudeCodeSessions } from "../src/sessions.js"

test("account windows exclude model-specific and local diagnostic percentages", () => {
  const result = parseClaudeUsage(`You are currently using your subscription
Current session: 51% used · resets Sep 24, 9:40pm (America/Indiana/Indianapolis)
Current week (all models): 21% used · resets Sep 30, 10am (America/Indiana/Indianapolis)
Current week (Fable): 22% used · resets Sep 30, 10am
Last 24h · 1287 requests · 23 sessions
  75% of your usage was at >150k context`)
  expect(result.windows).toEqual([
    { id: "five-hour", label: "5-hour", usedPercent: 51, reset: "Sep 24, 9:40pm (America/Indiana/Indianapolis)" },
    { id: "weekly", label: "Weekly", usedPercent: 21, reset: "Sep 30, 10am (America/Indiana/Indianapolis)" },
  ])
})

test("unrecognized or API-account output never invents quotas", () => {
  expect(parseClaudeUsage("API billing is enabled").windows).toEqual([])
  expect(parseClaudeUsage("Usage unavailable").message).toBeTruthy()
  expect(
    parseClaudeUsage("Current session: 0% used\r\nCurrent week: 100% used").windows.map((w) => w.usedPercent),
  ).toEqual([0, 100])
})

test("SDK usage probe disables hooks, tools and persistence and closes its query", async () => {
  let closed = false
  const create: ClaudeCodeSessions.CreateQuery = (input) => {
    expect(input.prompt).toBe("/usage")
    expect(input.options).toMatchObject({
      pathToClaudeCodeExecutable: "/bin/claude",
      tools: [],
      strictMcpConfig: true,
      persistSession: false,
      settings: { disableAllHooks: true },
      env: { CLAUDE_CONFIG_DIR: "/custom" },
    })
    return {
      close: () => {
        closed = true
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", is_error: false, result: "Current session: 12.5% used" } as never
      },
    }
  }
  const result = await readClaudeUsage(
    create,
    {
      pathToClaudeCodeExecutable: "/bin/claude",
      env: { CLAUDE_CONFIG_DIR: "/custom" },
    },
    new AbortController().signal,
  )
  expect(closed).toBe(true)
  expect(result.windows[0]?.usedPercent).toBe(12.5)
})
