import type { Tool } from "../tool/tool"
import type { Extension } from "./types"
import { ExtensionRunner } from "./runner"
import type { ZodType } from "zod"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "extension.wrapper" })

const PROTECTED_PATHS = [
  path.join(Global.Path.config, "trust.json"),
]

const PROTECTED_GLOBS = [
  ".env",
  ".env.local",
  ".env.production",
]

export function isProtectedPath(filePath: string): { blocked: boolean; reason?: string } {
  const normalized = path.resolve(filePath)

  for (const protectedPath of PROTECTED_PATHS) {
    if (normalized === path.resolve(protectedPath)) {
      return { blocked: true, reason: `Cannot write to protected path: ${filePath}` }
    }
  }

  const basename = path.basename(normalized)
  if (PROTECTED_GLOBS.includes(basename)) {
    return { blocked: true, reason: `Cannot write to protected file: ${filePath}` }
  }

  if (normalized.includes(path.sep + ".git" + path.sep)) {
    log.warn("writing to .git directory", { filePath })
    return { blocked: true, reason: `Cannot write to protected directory: .git (${filePath})` }
  }

  if (normalized.includes(path.sep + "node_modules" + path.sep)) {
    log.warn("writing to node_modules directory", { filePath })
    return { blocked: true, reason: `Cannot write to protected directory: node_modules (${filePath})` }
  }

  return { blocked: false }
}

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

        // Guardrail: check protected paths for write/edit tools
        if (tool.id === "write" || tool.id === "edit") {
          const filePath = (args as Record<string, unknown>).filePath as string | undefined
          if (filePath) {
            const guard = isProtectedPath(filePath)
            if (guard.blocked) {
              throw new Error(guard.reason ?? "blocked by guardrail")
            }
          }
        }

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
