import { expect, test } from "bun:test"
import { messageText, pinToolText } from "../../../src/routes/session/pin-text"

test("pin copy preserves original text and joins assistant text without reasoning", () => {
  expect(messageText({ id: "msg_user", type: "user", text: "\n  用户 question\n", time: { created: 1 } })).toBe(
    "\n  用户 question\n",
  )
  expect(
    messageText({
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      time: { created: 1 },
      content: [
        { type: "reasoning", text: "Private working" },
        { type: "text", text: "First paragraph" },
        { type: "text", text: "Second paragraph" },
      ],
    }),
  ).toBe("First paragraph\nSecond paragraph")
  expect(messageText({ id: "msg_empty", type: "user", text: "", time: { created: 1 } })).toBe("")
})

test("pin readers display tool output with real newlines and file names rather than embedded file bytes", () => {
  const text = pinToolText({
    type: "tool",
    id: "call_read",
    name: "read",
    time: { created: 1 },
    state: {
      status: "completed",
      input: { path: "file.txt" },
      content: [
        { type: "text", text: "First line\nSecond line" },
        { type: "file", name: "preview.png", mime: "image/png", uri: "data:image/png;base64,aW1hZ2U=" },
      ],
    },
  })
  expect(text).toContain('"path": "file.txt"')
  expect(text).toContain("First line\nSecond line\npreview.png")
  expect(text).not.toContain("aW1hZ2U=")
})
