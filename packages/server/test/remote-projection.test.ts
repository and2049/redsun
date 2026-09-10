import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { RemoteControl } from "@opencode/schema/remote-control"
import { RemoteProjection } from "../src/remote-projection"
import { RemoteAccess } from "../src/remote-access"

test("companion history excludes opaque provider state, metadata, file URIs and raw errors", () => {
  const message = Schema.decodeUnknownSync(SessionMessage.Info)({
    id: "msg_fixture",
    type: "assistant",
    time: { created: 1 },
    metadata: { secret: "private-metadata" },
    agent: "compose",
    model: { id: "fixture", providerID: "fixture" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    error: { type: "provider", message: "private-provider-error" },
    content: [
      { type: "text", text: "Visible answer", state: { secret: "private-provider-state" } },
      {
        type: "tool",
        id: "call",
        name: "read",
        time: { created: 1 },
        providerState: { secret: "private-tool-state" },
        state: {
          status: "completed",
          input: {},
          metadata: { secret: "private-tool-metadata" },
          content: [
            { type: "text", text: "Visible output" },
            { type: "file", uri: "file:///private-path", mime: "text/plain" },
          ],
        },
      },
    ],
  })
  const projected = RemoteProjection.message(message)
  expect(Schema.is(SessionMessage.Info)(projected)).toBe(true)
  const text = JSON.stringify(projected)
  expect(text).not.toContain("private-")
  expect(text).toContain("Visible answer")
  expect(text).toContain("Visible output")
  expect(JSON.stringify(message)).toContain("private-provider-state")
})

test("companion synchronization frames conform to their canonical event schemas", () => {
  const frame = RemoteAccess.eventFrame(
    'data: {"id":"evt_fixture","created":1,"type":"session.text.delta","data":{"text":"not forwarded"}}\n\n',
  )
  expect(Schema.is(RemoteControl.Sync)(JSON.parse(frame.slice(6)))).toBe(true)
  expect(frame).not.toContain("not forwarded")
})
