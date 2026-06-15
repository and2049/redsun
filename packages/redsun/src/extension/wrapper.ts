import type { Tool } from "../tool/tool"
import type { Extension } from "./types"
import { ExtensionRunner } from "./runner"
import type { ZodType } from "zod"

export namespace ExtensionWrapper {
  export interface ResolvedTool {
    id: string
    description: string
    parameters: ZodType
    execute: (args: Record<string, unknown>, ctx: Tool.Context) => Promise<{
      title: string
      metadata: Record<string, unknown>
      output: string
      attachments?: unknown[]
    }>
  }

  export function wrapExecute(
    tool: ResolvedTool,
    runner: ExtensionRunner.State,
    source: Extension.SourceInfo,
    contextFactory: () => Extension.Context,
  ): ResolvedTool {
    const originalExecute = tool.execute
    return {
      ...tool,
      execute: async (args, ctx) => {
        const eventCtx = contextFactory()
        const callEvent: Extension.ToolCallEvent = {
          type: "tool_call",
          toolCallId: ctx.callID ?? "",
          toolName: tool.id,
          input: args as Record<string, unknown>,
        }
        const callResult = await ExtensionRunner.emit(runner, callEvent, eventCtx)
        const block = (callResult as Extension.ToolCallResult | undefined)?.block
        if (block) {
          const reason = (callResult as Extension.ToolCallResult | undefined)?.reason ?? "blocked by extension"
          throw new Error(reason)
        }

        const result = await originalExecute(args, ctx)

        const resultEvent: Extension.ToolResultEvent = {
          type: "tool_result",
          toolCallId: ctx.callID ?? "",
          toolName: tool.id,
          input: args as Record<string, unknown>,
          output: result.output,
          metadata: (result.metadata ?? {}) as Record<string, unknown>,
          isError: false,
        }
        const resultMutation = await ExtensionRunner.emit(runner, resultEvent, eventCtx)
        if (resultMutation && typeof resultMutation === "object") {
          const m = resultMutation as Extension.ToolResultEventResult
          if (typeof m.output === "string") result.output = m.output
          if (m.metadata) result.metadata = m.metadata as any
        }
        return result
      },
    }
  }
}
