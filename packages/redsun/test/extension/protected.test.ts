import { describe, expect, test } from "bun:test"
import path from "node:path"
import { isProtectedPath } from "../../src/extension/protected"

describe("extension protected paths", () => {
  test.each([
    path.resolve(".redsun/extensions/example.ts"),
    path.resolve("nested/.redsun/extensions/example.ts"),
  ])("classifies %s as an extension path", (filepath) => {
    expect(isProtectedPath(filepath)).toMatchObject({ blocked: true, type: "extension" })
  })

  test.each([path.resolve(".git/config"), path.resolve("pkg/node_modules/item/index.js"), path.resolve(".env.local")])(
    "classifies %s as a system path",
    (filepath) => expect(isProtectedPath(filepath)).toMatchObject({ blocked: true, type: "system" }),
  )

  test("does not protect unrelated redsun paths", () => {
    expect(isProtectedPath(path.resolve(".redsun/config.json"))).toEqual({ blocked: false })
  })
})
