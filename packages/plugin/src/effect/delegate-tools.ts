export * as DelegateTools from "./delegate-tools.js"

import type { DelegatedToolBinding, DelegatedToolResult } from "./delegate.js"

// REDSUN: helpers every runtime needs when it serves the host's tools to its agent over MCP.

type Definitions = DelegatedToolBinding["definitions"]

/** The host's own extras every runtime may offer beside an agent's native tools. */
export const EXTRAS: ReadonlySet<string> = new Set(["subagent", "skill", "todowrite", "worker_model"])

/** Code Mode's tool; offered only with its catalog, which the host context delivers. */
export const CODE_MODE = "execute"

/**
 * The host tools one turn serves, from a canonical binding. `all` is everything a native redsun
 * agent has (an agent confined to host tools); `extras` is the host's own extras plus connected
 * MCP tools exposed directly. `available`, when given, is the request-level allowlist (core's
 * tool choice and hooks already applied) and always intersects. Code Mode only comes with its
 * catalog. Pure: the binding stays canonical and the selection is the runtime's view of it.
 */
export const select = (
  binding: Pick<DelegatedToolBinding, "definitions" | "direct" | "codeMode">,
  input: { readonly mode: "all" | "extras"; readonly available?: readonly string[] },
): Definitions => {
  const available = input.available === undefined ? undefined : new Set(input.available)
  return binding.definitions.filter((item) => {
    if (available && !available.has(item.name)) return false
    if (item.name === CODE_MODE) return !!binding.codeMode
    return input.mode === "all" || EXTRAS.has(item.name) || binding.direct.has(item.name)
  })
}

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
