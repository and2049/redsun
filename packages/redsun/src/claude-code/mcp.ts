import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import type { Tool as AiTool } from "ai"
import { z } from "zod"

/**
 * In-process MCP server exposing redsun's task delegation to a Claude Code
 * main session. The handler wraps the already-resolved AI-SDK `task` tool
 * from SessionTools.resolve, so permission asks, subagent-depth limits,
 * task_router validation, plugin execute hooks, and background semantics are
 * reused verbatim. This is what lets a Claude-Code compose coordinator hand
 * work to workers running on any other configured provider.
 */

export interface TaskToolAccess {
  /** The current turn's resolved tools; refreshed by the runtime each turn. */
  readonly getTaskTool: () => AiTool | undefined
  readonly getMessages: () => unknown[]
  readonly getAbort: () => AbortSignal | undefined
}

const DESCRIPTION = [
  "Delegate a scoped task to one of redsun's configured subagents (worker, explore, general).",
  "Workers run on the worker model configured in redsun — use this to route implementation or research",
  "work to non-Anthropic models the host has configured. Returns the subagent's final report as",
  '<task id="..." state="...">; pass a prior task_id to resume the same subagent session.',
].join(" ")

let counter = 0

export function makeTaskServer(access: TaskToolAccess): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "redsun",
    tools: [
      tool(
        "task",
        DESCRIPTION,
        {
          description: z.string().describe("A short (3-5 words) description of the task"),
          prompt: z.string().describe("The task for the agent to perform"),
          subagent_type: z.string().describe("The type of specialized agent to use for this task"),
          task_id: z
            .string()
            .optional()
            .describe("Set only to resume a previous task; continues the same subagent session"),
          background: z
            .boolean()
            .optional()
            .describe("Run the agent in the background; you will be notified when it completes"),
        },
        async (args) => {
          const task = access.getTaskTool()
          if (!task?.execute)
            return {
              content: [{ type: "text", text: "Task delegation is not available for this agent." }],
              isError: true,
            }
          try {
            const result = await task.execute(args, {
              toolCallId: `claude-code-task-${++counter}`,
              messages: access.getMessages() as never,
              abortSignal: access.getAbort() ?? new AbortController().signal,
            })
            const output =
              typeof result === "string" ? result : ((result as { output?: string })?.output ?? JSON.stringify(result))
            return { content: [{ type: "text", text: output }] }
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            }
          }
        },
      ),
    ],
  })
}

export * as ClaudeCodeMcp from "./mcp"
