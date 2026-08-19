import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigNormalize } from "@opencode-ai/core/config/normalize"
import { Info } from "@opencode-ai/schema/config"

// REDSUN: `claude_code` is carried by normalize's `nativeAtomic` passthrough.
// Adding the field to the schema alone is not enough - normalize rebuilds the
// encoded config from that list, so an omission silently drops every setting
// before it reaches the provider plugin, with no error anywhere.

const options = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const

const normalized = (input: unknown) => {
  const result = ConfigNormalize.normalize(input)
  expect(result.type).toBe("normalized")
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return result.encoded
}

const decoded = (input: unknown) => Schema.decodeUnknownSync(Info, options)(normalized(input))

const full = {
  enabled: true,
  binary_path: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
  config_dir: "/home/me/.claude",
  permission_mode: "acceptEdits",
  worker_permission_mode: "plan",
  extra_args: ["--verbose"],
  env: { CLAUDE_DEBUG: "1" },
}

describe("config normalization of claude_code", () => {
  test("carries every field through normalization", () => {
    expect(normalized({ claude_code: full })["claude_code"]).toEqual(full)
  })

  test("survives the decode that follows normalization", () => {
    expect(decoded({ claude_code: full }).claude_code).toMatchObject(full)
  })

  test("carries an empty section rather than dropping the key", () => {
    // The fast-check round-trip property that caught the original bug reduced
    // to exactly this counterexample.
    expect(normalized({ claude_code: {} })["claude_code"]).toEqual({})
  })

  test("leaves the key absent when the user did not set it", () => {
    expect(normalized({})).not.toHaveProperty("claude_code")
  })

  test("carries the section alongside other native settings", () => {
    const result = normalized({ model: "anthropic/claude-sonnet-4", claude_code: { permission_mode: "plan" } })
    expect(result["model"]).toEqual({ providerID: "anthropic", model: "claude-sonnet-4" })
    expect(result["claude_code"]).toEqual({ permission_mode: "plan" })
  })
})
