import { describe, expect, test } from "bun:test"
import { maskAccessToken } from "../../src/cli/cmd/mcp"

describe("MCP debug token masking", () => {
  test("shows only token edges", () => {
    expect(maskAccessToken("abcdefghijklmnop")).toBe("abcd***mnop")
  })

  test("fully masks short tokens", () => {
    expect(maskAccessToken("short")).toBe("***")
  })
})
