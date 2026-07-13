import type { Tool } from "../tool/tool"
import type { Extension } from "./types"
import { ExtensionRunner } from "./runner"
import type { ZodType } from "zod"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
import { Permission } from "../permission"
import { Instance } from "../project/instance"
import { Patch } from "../patch"

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
  const delimiterRegex = /[\s'"|;&<>(){}$`]+/
  const parts = command.split(delimiterRegex)
  for (const part of parts) {
    if (part.length > 1 && (part.includes(path.sep) || part.startsWith(".") || part.startsWith("/"))) {
      tokens.push(part)
    }
  }
  return tokens
}

function resolveProjectPath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath
  try {
    return path.resolve(Instance.directory, filePath)
  } catch {
    return filePath
  }
}

function writePaths(toolID: string, args: Record<string, unknown>) {
  const paths = typeof args.filePath === "string" ? [args.filePath] : []
  if (toolID !== "patch" || typeof args.patchText !== "string") return paths
  try {
    for (const hunk of Patch.parsePatch(args.patchText).hunks) {
      paths.push(hunk.path)
      if (hunk.type === "update" && hunk.move_path) paths.push(hunk.move_path)
    }
  } catch {
    // Let the patch tool report parse failures through its normal error path.
  }
  return paths
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

        // Guardrail: check all path-bearing write requests before execution.
        for (const filePath of writePaths(tool.id, args)) {
          const resolvedPath = resolveProjectPath(filePath)
          const guard = isProtectedPath(resolvedPath)
          if (guard.blocked) {
            if (guard.type === "extension") {
              await Permission.ask({
                type: "extension_write",
                title: "Write Extension",
                pattern: resolvedPath,
                callID: ctx.callID,
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                metadata: { filePath: resolvedPath },
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
              const guard = isProtectedPath(resolveProjectPath(token))
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

        let result: Awaited<ReturnType<typeof originalExecute>>
        try {
          result = await originalExecute(args, ctx)
        } catch (error) {
          await ExtensionRunner.emit(
            runner,
            {
              type: "tool_result",
              toolCallId: ctx.callID ?? "",
              toolName: tool.id,
              input: args as Record<string, unknown>,
              output: error instanceof Error ? error.message : String(error),
              metadata: {},
              isError: true,
            } satisfies Extension.ToolResultEvent,
            eventCtx,
          )
          throw error
        }

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
