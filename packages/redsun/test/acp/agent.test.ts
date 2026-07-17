import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import type { AssistantMessage } from "@redsun/sdk/v2"

function assistant(error?: AssistantMessage["error"]): AssistantMessage {
  return {
    id: "message-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    error,
    parentID: "user-1",
    modelID: "model-1",
    providerID: "provider-1",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("ACP prompt results", () => {
  test("maps ordinary and terminal assistant outcomes", () => {
    expect(ACP.promptResponse(assistant()).stopReason).toBe("end_turn")
    expect(
      ACP.promptResponse(assistant({ name: "MessageAbortedError", data: { message: "cancelled" } })).stopReason,
    ).toBe("cancelled")
    expect(
      ACP.promptResponse(assistant({ name: "MessageOutputLengthError", data: {} })).stopReason,
    ).toBe("max_tokens")
    expect(
      ACP.promptResponse(assistant({ name: "ContentFilterError", data: { message: "blocked" } })).stopReason,
    ).toBe("refusal")
  })

  test("surfaces authentication and provider failures", () => {
    expect(() =>
      ACP.promptResponse(
        assistant({ name: "ProviderAuthError", data: { providerID: "openai", message: "login required" } }),
      ),
    ).toThrow()
    expect(() =>
      ACP.promptResponse(
        assistant({ name: "UnknownError", data: { message: "provider failed" } }),
      ),
    ).toThrow("provider failed")
  })
})
