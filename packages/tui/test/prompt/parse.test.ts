import { expect, test } from "bun:test"
import type { KeymapCommand } from "../../src/context/keymap"
import { argumentSlash, parseFileLineRange, parseSlashHead, stripFileLineRange } from "../../src/prompt/parse"

test("preserves file line-range parsing semantics", () => {
  expect([
    parseFileLineRange("src/app.ts#7"),
    parseFileLineRange("src/app.ts#12-20"),
    parseFileLineRange("src/app.ts#12-"),
    parseFileLineRange("src/app.ts#12-12"),
    parseFileLineRange("src/app.ts#bad"),
    parseFileLineRange("src/app.ts#"),
    parseFileLineRange("report#2026.md"),
    parseFileLineRange("#notes.md"),
    parseFileLineRange("#3"),
    parseFileLineRange("report#2026.md#3"),
    parseFileLineRange("report#2026.md#3-10"),
    parseFileLineRange("#notes.md#3"),
    parseFileLineRange("src/app.ts"),
  ]).toEqual([
    { base: "src/app.ts", lineRange: { startLine: 7, endLine: undefined } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: 20 } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: undefined } },
    { base: "src/app.ts", lineRange: { startLine: 12, endLine: undefined } },
    { base: "src/app.ts#bad" },
    { base: "src/app.ts#" },
    { base: "report#2026.md" },
    { base: "#notes.md" },
    { base: "#3" },
    { base: "report#2026.md", lineRange: { startLine: 3, endLine: undefined } },
    { base: "report#2026.md", lineRange: { startLine: 3, endLine: 10 } },
    { base: "#notes.md", lineRange: { startLine: 3, endLine: undefined } },
    { base: "src/app.ts" },
  ])
  expect([
    stripFileLineRange("report#2026.md"),
    stripFileLineRange("#notes.md"),
    stripFileLineRange("report#2026.md#3"),
    stripFileLineRange("src/app.ts#12-20"),
  ]).toEqual(["report#2026.md", "#notes.md", "report#2026.md", "src/app.ts"])
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
