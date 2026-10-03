import { expect, test } from "bun:test"
import type { KeymapCommand } from "../../src/context/keymap"
import { argumentSlash, parseFileLineRange, parseSlashHead } from "../../src/prompt/parse"

test("preserves file line-range parsing semantics", () => {
  expect([
    parseFileLineRange("src/app.ts#12-20"),
    parseFileLineRange("src/app.ts#12-"),
    parseFileLineRange("src/app.ts#12-12"),
    parseFileLineRange("src/app.ts#bad"),
    parseFileLineRange("src/app.ts"),
  ]).toEqual([
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: 20 } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: undefined } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: undefined } },
    { base: "src/app.ts" },
    { base: "src/app.ts" },
  ])
})

test("keeps frontend-specific slash separators", () => {
  expect(parseSlashHead("/editor\rfirst")).toEqual({ name: "editor\rfirst", arguments: "", end: 13 })
  expect(parseSlashHead("/editor\rfirst", /\s/)).toEqual({ name: "editor", arguments: "first", end: 7 })
  expect(parseSlashHead("editor")).toBeUndefined()
})

test("argumentSlash routes typed input to argument-taking commands only", () => {
  const cd = { id: "cd", slash: { name: "cd", arguments: true }, run: () => undefined } satisfies KeymapCommand
  const models = {
    id: "models",
    slash: { name: "models", aliases: ["mo"], arguments: "optional" },
    run: () => undefined,
  } satisfies KeymapCommand
  const plain = { id: "plain", slash: { name: "plain" }, run: () => undefined } satisfies KeymapCommand
  const commands = [cd, models, plain]
  expect(argumentSlash("/cd src", commands)).toEqual({ command: cd, input: "src" })
  expect(argumentSlash("/models refresh", commands)).toEqual({ command: models, input: "refresh" })
  expect(argumentSlash("/mo", commands)).toEqual({ command: models, input: "" })
  expect(argumentSlash("/plain arg", commands)).toBeUndefined()
  expect(argumentSlash("plain", commands)).toBeUndefined()
})
