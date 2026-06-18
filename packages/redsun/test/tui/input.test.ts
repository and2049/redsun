import { describe, expect, test } from "bun:test"
import type { ParsedKey } from "@opentui/core"
import { getCommandSuggestions, resolveCommandAlias } from "../../src/cli/cmd/tui/input/command-mode"
import { matchScopedKeybind } from "../../src/cli/cmd/tui/input/key-scope"
import { getVimModeTransition } from "../../src/cli/cmd/tui/input/mode"
import {
  shouldEnterShellEntry,
  shouldExitShellEntry,
  shouldUseAutocomplete,
} from "../../src/cli/cmd/tui/input/prompt-entry"
import { getSessionNavigationAction } from "../../src/cli/cmd/tui/input/session-navigation"
import { Keybind } from "../../src/util/keybind"

function key(name: string, options: Partial<ParsedKey> = {}) {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    super: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    paste: false,
    printable: true,
    ...options,
  } as ParsedKey
}

describe("TUI Vim mode transitions", () => {
  test("normal mode enters insert and command modes", () => {
    expect(getVimModeTransition("normal", key("i"))).toEqual({
      mode: "insert",
      preventDefault: true,
      reason: "enter-insert",
    })
    expect(getVimModeTransition("normal", key(":"))).toEqual({
      mode: "command",
      preventDefault: true,
      reason: "enter-command",
    })
  })

  test("insert and command modes exit to normal mode", () => {
    expect(getVimModeTransition("insert", key("escape"))).toEqual({
      mode: "normal",
      preventDefault: true,
      reason: "exit-insert",
    })
    expect(getVimModeTransition("command", key("escape"))).toEqual({
      mode: "normal",
      preventDefault: true,
      reason: "exit-command",
    })
    expect(getVimModeTransition("command", key("return"))).toEqual({
      mode: "normal",
      preventDefault: true,
      reason: "execute-command",
    })
  })
})

describe("TUI scoped key matching", () => {
  test("global scope preserves normal-mode implicit leader behavior", () => {
    expect(
      matchScopedKeybind(Keybind.parse("<leader>f")[0], key("f"), "global", {
        leader: false,
        vimMode: "normal",
      }),
    ).toBe(true)
    expect(
      matchScopedKeybind(Keybind.parse("ctrl+f")[0], key("f", { ctrl: true }), "global", {
        leader: false,
        vimMode: "normal",
      }),
    ).toBe(false)
  })

  test("dialog scope matches panel-local controls without implicit leader", () => {
    for (const name of ["f", "a", "d", "r"]) {
      expect(
        matchScopedKeybind(Keybind.parse(`ctrl+${name}`)[0], key(name, { ctrl: true }), "dialog", {
          leader: false,
          vimMode: "normal",
        }),
      ).toBe(true)
    }
  })

  test("dialog scope does not match leader binding from a plain control key", () => {
    expect(
      matchScopedKeybind(Keybind.parse("<leader>f")[0], key("f", { ctrl: true }), "dialog", {
        leader: false,
        vimMode: "normal",
      }),
    ).toBe(false)
  })
})

describe("TUI command mode helpers", () => {
  test("resolves aliases and passes unknown commands through", () => {
    expect(resolveCommandAlias("models")).toBe("model.list")
    expect(resolveCommandAlias("ls")).toBe("session.list")
    expect(resolveCommandAlias("custom.command")).toBe("custom.command")
  })

  test("returns command suggestions from aliases", () => {
    expect(getCommandSuggestions("mod", 3)).toContain("models")
  })
})

describe("TUI prompt and session input helpers", () => {
  test("recognizes prompt shell entry transitions", () => {
    expect(shouldEnterShellEntry(key("!"), 0)).toBe(true)
    expect(shouldExitShellEntry("shell", key("escape"), 1)).toBe(true)
    expect(shouldExitShellEntry("shell", key("backspace"), 0)).toBe(true)
    expect(shouldUseAutocomplete("normal")).toBe(true)
    expect(shouldUseAutocomplete("shell")).toBe(false)
  })

  test("maps session normal-mode navigation keys", () => {
    expect(getSessionNavigationAction("normal", key("j"))).toEqual({ type: "scroll-by", amount: 1 })
    expect(getSessionNavigationAction("normal", key("k"))).toEqual({ type: "scroll-by", amount: -1 })
    expect(getSessionNavigationAction("normal", key("g"))).toEqual({ type: "scroll-top" })
    expect(getSessionNavigationAction("normal", key("g", { shift: true }))).toEqual({ type: "scroll-bottom" })
    expect(getSessionNavigationAction("insert", key("j"))).toBeUndefined()
  })
})
