import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { ProviderTransform } from "../provider/transform"
import type { Provider } from "../provider/provider"

export function convertMcpTool(mcpTool: MCPToolDef, client: Client, model: Provider.Model, timeout?: number): Tool {
  const inputSchema = mcpTool.inputSchema
  const schema = ProviderTransform.schema(model, {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: ((inputSchema as any).properties ?? {}) as any,
    additionalProperties: false,
  } as any) as JSONSchema7

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown, options) => {
      const result = await (client as any).callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        undefined,
        {
          resetTimeoutOnProgress: true,
          signal: options.abortSignal,
          timeout,
          onprogress: () => {},
        },
      )
      if (result.isError) {
        throw new Error(
          result.content
            .flatMap((item: any) => (item.type === "text" ? [item.text] : []))
            .filter((text: string) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      }
      if ((!result.content || result.content.length === 0) && result.structuredContent != null) {
        return {
          ...result,
          content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
        }
      }
      return result
    },
  })
}
