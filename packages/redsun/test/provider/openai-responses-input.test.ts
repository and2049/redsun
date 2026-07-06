import { describe, expect, test } from "bun:test"
import { convertToOpenAIResponsesInput } from "../../src/provider/sdk/openai-compatible/src/responses/convert-to-openai-responses-input"

describe("convertToOpenAIResponsesInput", () => {
  test("omits stateless assistant item ids when store is false", async () => {
    const { input } = await convertToOpenAIResponsesInput({
      systemMessageMode: "system",
      store: false,
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "hello",
              providerOptions: { openai: { itemId: "msg_1" } },
            },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "bash",
              input: { command: "echo hi" },
              providerOptions: { openai: { itemId: "fc_1" } },
            },
          ],
        },
      ] as any,
    })

    expect(input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: JSON.stringify({ command: "echo hi" }),
      },
    ])
  })

  test("keeps only encrypted reasoning when store is false", async () => {
    const { input } = await convertToOpenAIResponsesInput({
      systemMessageMode: "system",
      store: false,
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "no encrypted state",
              providerOptions: { openai: { itemId: "rs_1" } },
            },
            {
              type: "reasoning",
              text: "has encrypted state",
              providerOptions: {
                openai: {
                  itemId: "rs_2",
                  reasoningEncryptedContent: "encrypted",
                },
              },
            },
          ],
        },
      ] as any,
    })

    expect(input).toEqual([
      {
        type: "reasoning",
        id: "rs_2",
        encrypted_content: "encrypted",
        summary: [{ type: "summary_text", text: "has encrypted state" }],
      },
    ])
  })
})
