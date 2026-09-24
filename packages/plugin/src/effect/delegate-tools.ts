export * as DelegateTools from "./delegate-tools.js"

import type { DelegatedToolBinding, DelegatedToolResult } from "./delegate.js"

// REDSUN: helpers every runtime needs when it serves the host's tools to its agent over MCP.

type Definitions = DelegatedToolBinding["definitions"]

/**
 * A key for the tool catalog an agent lists: agents cache `tools/list`, so a different key means
 * the agent needs a new session to see the change.
 */
export const catalogKey = (definitions: Definitions) =>
  JSON.stringify(
    definitions
      .map((item) => [item.name, item.inputSchema, item.description] as const)
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )

/** A host tool result as MCP `content`: text and inline images; anything else as JSON text. */
export const mcpContent = (result: DelegatedToolResult) =>
  result.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : part.type === "file" && part.mime.startsWith("image/") && part.uri.startsWith(`data:${part.mime};base64,`)
        ? { type: "image" as const, data: part.uri.slice(`data:${part.mime};base64,`.length), mimeType: part.mime }
        : { type: "text" as const, text: JSON.stringify(part) },
  )
