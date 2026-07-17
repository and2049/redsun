import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"

test("OpenAI Responses serializes forced Pro reasoning options", async () => {
  let body: Record<string, any> | undefined
  const mockFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        id: "response-1",
        created_at: 0,
        model: "gpt-5.6-sol",
        object: "response",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        status: "completed",
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createOpenAI({ apiKey: "test", fetch: mockFetch }).responses("gpt-5.6-sol")

  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Solve this" }] }],
    providerOptions: {
      openai: {
        forceReasoning: true,
        reasoningEffort: "high",
        reasoningMode: "pro",
        reasoningSummary: "auto",
        store: false,
      },
    },
  })

  expect(body?.reasoning).toEqual({ effort: "high", mode: "pro", summary: "auto" })
  expect(body?.store).toBe(false)
  expect(body?.include).toContain("reasoning.encrypted_content")
})

test("Azure Responses serializes forced GPT-5.6 reasoning options", async () => {
  let body: Record<string, any> | undefined
  const mockFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        id: "response-azure-1",
        created_at: 0,
        model: "gpt-5.6",
        object: "response",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        status: "completed",
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createAzure({ apiKey: "test", resourceName: "test", fetch: mockFetch }).responses("gpt-5.6")

  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Solve this" }] }],
    providerOptions: {
      openai: {
        forceReasoning: true,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        store: false,
      },
      azure: {
        forceReasoning: true,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        store: false,
      },
    },
  })

  expect(body?.reasoning).toEqual({ effort: "medium", summary: "auto" })
  expect(body?.store).toBe(false)
})
