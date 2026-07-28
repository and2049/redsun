import { Client } from "@modelcontextprotocol/client"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/client"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"
import type { McpTool } from "./index"

const DEFAULT_TIMEOUT = 30_000
export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(entry: McpTool): Tool {
  const mcpTool = entry.def
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const result = await callTool(entry, (args || {}) as Record<string, unknown>, options.abortSignal)
      if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
        return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export async function callTool(entry: McpTool, args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await entry.client.callTool(
    { name: entry.def.name, arguments: args },
    {
      resetTimeoutOnProgress: true,
      signal,
      timeout: entry.timeout,
      onprogress: () => {},
    },
  )
  return result
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return client.listPrompts(undefined, { timeout }).then((result) => result.prompts)
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return client.listResources(undefined, { timeout }).then((result) => result.resources)
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return client.listResourceTemplates(undefined, { timeout }).then((result) => result.resourceTemplates)
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: async () => (await client.listTools(undefined, { timeout })).tools,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export * as McpCatalog from "./catalog"
