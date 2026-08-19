import { expect, test } from "bun:test"
import { COUNT_MAX, NORMAL_LETTER_COMMANDS, commandAliases, pushCount, resolveCommand, transition } from "../src/vim"
import { TuiKeybind } from "../src/config/keybind"

const key = (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => ({
  name,
  ctrl: modifiers.ctrl ?? false,
  meta: modifiers.meta ?? false,
})

test("moves between the three modes", () => {
  expect(transition("insert", key("escape"))).toBe("normal")
  expect(transition("normal", key("i"))).toBe("insert")
  expect(transition("normal", key(":"))).toBe("command")
  expect(transition("command", key("escape"))).toBe("normal")
  expect(transition("command", key("return"))).toBe("normal")
})

test("leaves modified keys to the keymap", () => {
  // ctrl+c must stay an interrupt, not an escape into normal mode.
  expect(transition("insert", key("escape", { ctrl: true }))).toBeUndefined()
  expect(transition("normal", key("i", { meta: true }))).toBeUndefined()
})

test("stays put when nothing applies", () => {
  expect(transition("insert", key("i"))).toBeUndefined()
  expect(transition("normal", key("escape"))).toBeUndefined()
  expect(transition("command", key("i"))).toBeUndefined()
})

test("accumulates a count prefix, ignoring a leading zero", () => {
  expect(pushCount(null, 5)).toBe(5)
  expect(pushCount(5, 0)).toBe(50)
  expect(pushCount(50, 3)).toBe(503)
  // `0` keeps its own meaning until a count is already running: vim's 10j, not 0j.
  expect(pushCount(null, 0)).toBeNull()
})

test("caps the count so a leaned-on digit cannot run away", () => {
  expect(pushCount(COUNT_MAX, 9)).toBe(COUNT_MAX)
  expect(pushCount(500, 9)).toBe(COUNT_MAX)
})

test("resolves `:` aliases and passes command ids through", () => {
  expect(resolveCommand("ls")).toBe("session.list")
  expect(resolveCommand("  Q  ")).toBe("app.exit")
  expect(resolveCommand("session.list")).toBe("session.list")
  // An unknown word resolves to itself so the bar can report it as unknown
  // rather than silently running something else.
  expect(resolveCommand("nonsense")).toBe("nonsense")
})

test("only names commands that exist", () => {
  // An alias or letter pointing at a command that has been renamed away is a
  // key that silently does nothing, which is worse than an unbound key.
  const defined = new Set(Object.keys(TuiKeybind.Definitions))
  for (const [alias, command] of Object.entries(commandAliases)) {
    expect(defined.has(command), `${alias} -> ${command}`).toBe(true)
  }
  for (const [letter, command] of Object.entries(NORMAL_LETTER_COMMANDS)) {
    expect(defined.has(command), `${letter} -> ${command}`).toBe(true)
  }
})

test("binds every normal-mode letter once", () => {
  const letters = Object.keys(NORMAL_LETTER_COMMANDS)
  expect(new Set(letters).size).toBe(letters.length)
  // `i` returns to insert and `:` opens the command bar, so neither can also be
  // a command.
  expect(letters).not.toContain("i")
  expect(letters).not.toContain(":")
})
