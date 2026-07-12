import { expect, test } from "bun:test"
import { createXai } from "@ai-sdk/xai"

test("xAI Responses sends cache keys and PDF input", async () => {
  let body: Record<string, any> | undefined
  const mockFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        id: "response-1",
        created_at: 0,
        model: "grok-4",
        object: "response",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        status: "completed",
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createXai({
    apiKey: "test",
    fetch: mockFetch,
  }).responses("grok-4")

  await model.doGenerate({
    prompt: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          {
            type: "file",
            data: new TextEncoder().encode("pdf"),
            mediaType: "application/pdf",
            filename: "document.pdf",
          },
        ],
      },
    ],
    providerOptions: { xai: { promptCacheKey: "session-123" } },
  })

  expect(body?.prompt_cache_key).toBe("session-123")
  expect(body?.input[0].content).toEqual([
    { type: "input_text", text: "Read this" },
    {
      type: "input_file",
      filename: "document.pdf",
      file_data: "data:application/pdf;base64,cGRm",
    },
  ])
})
