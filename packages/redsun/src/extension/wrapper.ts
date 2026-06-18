import type { Tool } from "../tool/tool"
import type { Extension } from "./types"
import { ExtensionRunner } from "./runner"
import type { ZodType } from "zod"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
import { Permission } from "../permission"

const log = Log.create({ service: "extension.wrapper" })

const PROTECTED_PATHS = [
  path.join(Global.Path.config, "trust.json"),
]

const PROTECTED_GLOBS = [
  ".env",
  ".env.local",
  ".env.production",
]

export function isProtectedPath(filePath: string): { blocked: boolean; reason?: string; type?: "extension" | "system" } {
  const normalized = path.resolve(filePath)

  for (const protectedPath of PROTECTED_PATHS) {
    if (normalized === path.resolve(protectedPath)) {
      return { blocked: true, reason: `Cannot write to protected path: ${filePath}`, type: "system" }
    }
  }

  const basename = path.basename(normalized)
  if (PROTECTED_GLOBS.includes(basename)) {
    return { blocked: true, reason: `Cannot write to protected file: ${filePath}`, type: "system" }
  }

  const segments = normalized.split(path.sep)
  for (const dir of [".git", "node_modules"]) {
    if (segments.includes(dir)) {
      log.warn("writing to protected directory", { filePath, dir })
      return { blocked: true, reason: `Cannot write to protected directory: ${dir} (${filePath})`, type: "system" }
    }
  }

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === ".redsun" && segments[i + 1] === "extensions") {
      const dir = path.join(".redsun", "extensions")
      log.warn("writing to protected directory", { filePath, dir })
      return { blocked: true, reason: `Cannot write to protected directory: ${dir} (${filePath})`, type: "extension" }
    }
  }

  return { blocked: false }
}

function extractPathLikeTokens(command: string): string[] {
  const tokens: string[] = []
  const delimiterRegex = /[\s'"|;&<>(){}$`\\]+/
  const parts = command.split(delimiterRegex)
  for (const part of parts) {
    if (part.length > 1 && (part.includes(path.sep) || part.startsWith(".") || part.startsWith("/"))) {
      tokens.push(part)
    }
  }
  return tokens
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

        // Guardrail: check protected paths for file-writing tools
        const filePath = (args as Record<string, unknown>).filePath as string | undefined
        if (filePath) {
          const guard = isProtectedPath(filePath)
          if (guard.blocked) {
            if (guard.type === "extension") {
              await Permission.ask({
                type: "extension_write",
                title: "Write Extension",
                pattern: filePath,
                callID: ctx.callID,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                metadata: { filePath },
              })
            } else {
              throw new Error(guard.reason ?? "blocked by guardrail")
            }
          }
        }

        if (tool.id === "bash") {
          const command = (args as Record<string, unknown>).command as string | undefined
          if (command) {
            const tokens = extractPathLikeTokens(command)
            for (const token of tokens) {
              const guard = isProtectedPath(token)
              if (guard.blocked) {
                if (guard.type === "extension") {
                  await Permission.ask({
                    type: "extension_write",
                    title: "Write Extension via Bash",
                    pattern: command,
                    callID: ctx.callID,
                    sessionID: ctx.sessionID,
                    messageID: ctx.messageID,
                    metadata: { command },
                  })
                } else {
                  throw new Error(guard.reason ?? "blocked by guardrail")
                }
              }
            }
            for (const p of PROTECTED_PATHS) {
              if (command.includes(path.basename(p))) {
                throw new Error(`Cannot reference protected path "${p}" via bash`)
              }
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
