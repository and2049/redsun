export * as ExtensionV2ToolAdapter from "./v2-tool-adapter"

import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { ToolFailure, ToolOutput } from "@opencode-ai/llm"
import { Tool } from "@opencode-ai/core/tool/tool"
import type { JsonSchema } from "effect"
import { Effect } from "effect"
import { z } from "zod"
import { isZodType, legacyJsonSchema, zodJsonSchema } from "@/tool/registry"

/**
 * Adapts a V1 extension tool definition to the v2 `Tool` contract so extension tools
 * are visible to v2 sessions through `Tools.Service`. Known v0 limitations: no
 * interactive `ask`, an inert abort signal, `metadata()` is a no-op, and attachments
 * are dropped (the v2 result shape has no attachment channel yet).
 */

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const toFailure = (error: unknown) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) })

export const adaptTool = (
  definition: ToolDefinition,
  project: { directory: string; worktree: string },
): Tool.AnyTool => {
  const args = definition.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.length > 0 && entries.every(([, value]) => isZodType(value))
  const inputSchema = (
    allZod ? zodJsonSchema(z.object(args as z.ZodRawShape)) : legacyJsonSchema(entries)
  ) as JsonSchema.JsonSchema
  return Tool.fromJsonSchema({
    description: definition.description,
    inputSchema,
    execute: (input, context) =>
      Effect.tryPromise({
        try: () => {
          const shim: ToolContext = {
            sessionID: context.sessionID,
            messageID: context.assistantMessageID,
            agent: context.agent,
            directory: project.directory,
            worktree: project.worktree,
            abort: new AbortController().signal,
            metadata: () => {},
            ask: () => Promise.reject(new Error("Interactive tool prompts are not available for v2 sessions yet")),
          }
          return definition.execute(input as never, shim)
        },
        catch: toFailure,
      }).pipe(
        Effect.flatMap((result) => {
          const output = typeof result === "string" ? result : result.output
          const isError = typeof result !== "string" && result.metadata?.isError === true
          if (isError) return Effect.fail(new ToolFailure({ message: output }))
          return Effect.succeed(ToolOutput.make(output, [{ type: "text", text: output }]))
        }),
      ),
  })
}

export const adaptTools = (
  tools: ReadonlyMap<string, { definition: ToolDefinition }>,
  project: { directory: string; worktree: string },
) => {
  const adapted: Record<string, Tool.AnyTool> = {}
  const skipped: string[] = []
  for (const [id, item] of tools) {
    if (!NAME_PATTERN.test(id)) {
      skipped.push(id)
      continue
    }
    adapted[id] = adaptTool(item.definition, project)
  }
  return { tools: adapted, skipped }
}
