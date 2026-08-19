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
