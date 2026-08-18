// REDSUN: in-process MCP server exposing v2's subagent delegation to a Claude
// Code session.
//
// This is what lets a Claude Code model act as a compose coordinator and hand
// work to workers running on any other configured provider. The handler executes
// the already-registered upstream `subagent` tool through the ordinary tool
// snapshot, so permission asserts, subagent-depth limits, worker model and
// variant resolution, and background semantics are all reused rather than
// reimplemented.
//
// The server is attached unconditionally: `mcpServers` is fixed at process start
// while the agent can change per turn, so gating attachment on the turn's tools
// would leave a mid-session switch into compose without delegation. Gating is
// the permission layer's job — a worker denies `subagent`, so the tool is
// present but refuses.
export * as ClaudeCodeMcp from "./mcp.js"

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

const NAME = "subagent"

const DESCRIPTION = [
  "Delegate a scoped task to one of redsun's configured subagents (worker, explore, general).",
  "Workers run on the worker model configured in redsun, so use this to route implementation or",
  "research work to models the host has configured rather than doing it inline.",
  "Returns the subagent's final response, plus a sessionID you can pass back to continue it.",
].join(" ")

export interface Delegate {
  /**
   * Execute the upstream subagent tool for this session. Resolves to the text
   * the subagent returned, or rejects with a message to show the model.
   */
  (input: {
    readonly agent: string
    readonly description: string
    readonly prompt: string
    readonly sessionID?: string
    readonly background?: boolean
  }): Promise<string>
}

export const makeSubagentServer = (delegate: Delegate): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name: "redsun",
    tools: [
      tool(
        NAME,
        DESCRIPTION,
        {
          agent: z.string().describe("The type of specialized agent to use for this task"),
          description: z.string().describe("A short (3-5 word) description of the task"),
          prompt: z.string().describe("The task for the subagent to perform"),
          sessionID: z
            .string()
            .optional()
            .describe("Set only to continue a previous subagent; continues that same session"),
          background: z
            .boolean()
            .optional()
            .describe("Run the subagent in the background; you are notified when it completes"),
        },
        async (args) => {
          try {
            return { content: [{ type: "text" as const, text: await delegate(args) }] }
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            }
          }
        },
      ),
    ],
  })
