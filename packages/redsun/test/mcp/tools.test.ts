import { describe, expect, test } from "bun:test"
import { MCP } from "../../src/mcp"
import { convertMcpTool } from "../../src/mcp/tool-convert"

const openaiModel = {
  providerID: "openai",
  api: {
    id: "gpt-4.1",
    npm: "@ai-sdk/openai",
  },
} as any

describe("MCP.convertMcpTool", () => {
  test("passes progress reset request options to callTool", async () => {
    let call: any
    const client = {
      async callTool(...args: any[]) {
        call = args
        return { content: [{ type: "text", text: "ok" }] }
      },
    } as any
    const abort = new AbortController()
    const tool = convertMcpTool(
      {
        name: "search",
        description: "search",
        inputSchema: { type: "object" },
      } as any,
      client,
      openaiModel,
      1234,
    ) as any

    await tool.execute({ query: "redsun" }, { abortSignal: abort.signal })

    expect(call[0]).toEqual({ name: "search", arguments: { query: "redsun" } })
    expect(call[2].resetTimeoutOnProgress).toBe(true)
    expect(call[2].signal).toBe(abort.signal)
    expect(call[2].timeout).toBe(1234)
    expect(typeof call[2].onprogress).toBe("function")
  })

  test("surfaces MCP server error text", async () => {
    const client = {
      async callTool() {
        return {
          isError: true,
          content: [
            { type: "text", text: "first failure" },
            { type: "image", data: "ignored" },
            { type: "text", text: "second failure" },
          ],
        }
      },
    } as any
    const tool = convertMcpTool(
      {
        name: "broken",
        description: "broken",
        inputSchema: { type: "object", properties: {} },
      } as any,
      client,
      openaiModel,
    ) as any

    await expect(tool.execute({}, { abortSignal: new AbortController().signal })).rejects.toThrow(
      "first failure\n\nsecond failure",
    )
  })

  test("falls back when MCP error content has no text", async () => {
    const client = {
      async callTool() {
        return {
          isError: true,
          content: [{ type: "image", data: "ignored" }],
        }
      },
    } as any
    const tool = convertMcpTool(
      {
        name: "broken",
        description: "broken",
        inputSchema: { type: "object" },
      } as any,
      client,
      openaiModel,
    ) as any

    await expect(tool.execute({}, { abortSignal: new AbortController().signal })).rejects.toThrow(
      "MCP tool returned an error",
    )
  })

  test("accepts MCP schemas without declared properties", () => {
    const client = {
      async callTool() {
        return { content: [] }
      },
    } as any
    const tool = convertMcpTool(
      {
        name: "empty",
        description: "empty",
        inputSchema: { type: "object" },
      } as any,
      client,
      openaiModel,
    ) as any

    expect(tool.inputSchema).toBeDefined()
  })

  test("uses structuredContent when content is empty", async () => {
    const client = {
      async callTool() {
        return {
          content: [],
          structuredContent: { answer: 42 },
        }
      },
    } as any
    const tool = convertMcpTool(
      {
        name: "structured",
        description: "structured",
        inputSchema: { type: "object" },
      } as any,
      client,
      openaiModel,
    ) as any

    const result = await tool.execute({}, { abortSignal: new AbortController().signal })

    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ answer: 42 }) }])
  })
})

describe("MCP.paginate", () => {
  test("follows cursors and preserves all page items", async () => {
    const calls: Array<string | undefined> = []
    const result = await MCP.paginate(
      async (cursor?: string) => {
        calls.push(cursor)
        if (!cursor) return { tools: [{ name: "a" }], nextCursor: "next" }
        return { tools: [{ name: "b" }] }
      },
      (page) => page.tools,
    )

    expect(calls).toEqual([undefined, "next"])
    expect(result).toEqual([{ name: "a" }, { name: "b" }])
  })
})
