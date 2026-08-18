import { describe, expect, it } from "bun:test"
import { ClaudeCodeMcp } from "@opencode-ai/core/plugin/redsun/claude-code/mcp"

/**
 * The SDK stores each tool's handler on the server instance. Reaching for it
 * keeps the test on the real `createSdkMcpServer` output rather than a stand-in,
 * so a change in the SDK's registration shape shows up here.
 */
const handler = (server: ReturnType<typeof ClaudeCodeMcp.makeSubagentServer>) => {
  const registered = (server.instance as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
  const entry = registered?.["subagent"] as { handler: (args: unknown, extra?: unknown) => Promise<unknown> }
  expect(entry?.handler).toBeInstanceOf(Function)
  return (args: Record<string, unknown>) => entry.handler(args, {})
}

describe("ClaudeCodeMcp.makeSubagentServer", () => {
  it("exposes exactly one delegation tool named for redsun", () => {
    const server = ClaudeCodeMcp.makeSubagentServer(async () => "unused")
    expect(server.name).toBe("redsun")
    const registered = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    // The model reaches this as `mcp__redsun__subagent`, which is the name the
    // compose redirect in permissions.ts points at.
    expect(Object.keys(registered)).toEqual(["subagent"])
  })

  it("passes the model's arguments straight through to the delegate", async () => {
    const seen: unknown[] = []
    const server = ClaudeCodeMcp.makeSubagentServer(async (args) => {
      seen.push(args)
      return "the worker's answer"
    })

    const result = await handler(server)({
      agent: "worker",
      description: "fix the parser",
      prompt: "make the tokenizer handle CRLF",
      sessionID: "ses_child",
      background: true,
    })

    expect(seen).toEqual([
      {
        agent: "worker",
        description: "fix the parser",
        prompt: "make the tokenizer handle CRLF",
        sessionID: "ses_child",
        background: true,
      },
    ])
    expect(result).toEqual({ content: [{ type: "text", text: "the worker's answer" }] })
  })

  it("returns a refusal as tool output rather than throwing at the CLI", async () => {
    // A worker denies `subagent`, so this is the path a nested delegation takes.
    // It has to reach the model as an error result, not kill the turn.
    const server = ClaudeCodeMcp.makeSubagentServer(async () => {
      throw new Error("Permission denied: subagent worker")
    })

    expect(await handler(server)({ agent: "worker", description: "nested", prompt: "go" })).toEqual({
      content: [{ type: "text", text: "Permission denied: subagent worker" }],
      isError: true,
    })
  })

  it("describes a non-Error rejection rather than reporting an empty failure", async () => {
    const server = ClaudeCodeMcp.makeSubagentServer(async () => {
      throw "delegation is unavailable"
    })

    expect(await handler(server)({ agent: "worker", description: "nested", prompt: "go" })).toEqual({
      content: [{ type: "text", text: "delegation is unavailable" }],
      isError: true,
    })
  })
})
