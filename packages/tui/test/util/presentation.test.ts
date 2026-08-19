import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  // The wordmark is new-session chrome; scrollback gets the name alone.
  expect(epilogue.split("\n")[0]).toBe("redsun")
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("redsun -s ses_123")
})
