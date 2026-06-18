import { describe, expect, test } from "bun:test"
import type { ParsedKey } from "@opentui/core"
import { getCommandSuggestions, resolveCommandAlias } from "../../src/cli/cmd/tui/input/command-mode"
import { matchScopedKeybind } from "../../src/cli/cmd/tui/input/key-scope"
import { getLeaderKeyAction } from "../../src/cli/cmd/tui/input/leader"
import {
  getVimModeTransition,
  isVimModeTransitionAllowed,
  modeForContext,
} from "../../src/cli/cmd/tui/input/mode"
import { getToolPermissionResponse, getTrustPermissionResponse } from "../../src/cli/cmd/tui/input/permission"
import {
  shouldEnterShellEntry,
  shouldExitShellEntry,
  shouldUseAutocomplete,
} from "../../src/cli/cmd/tui/input/prompt-entry"
import { getSessionNavigationAction } from "../../src/cli/cmd/tui/input/session-navigation"
import {
  buildSubagentSessionOptions,
  getChildCycleTarget,
  getFirstSessionGroupPermission,
  getSessionGroup,
  getSubagentHeaderInfo,
  isSubagentSession,
} from "../../src/cli/cmd/tui/input/subagent-session"
import { formatCacheHitRatio, formatContextStatus } from "../../src/cli/cmd/tui/input/token-display"
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
  test("global scope applies implicit leader to bare letters only in normal mode", () => {
    // Bare letters in normal mode get an implicit <leader> prefix so they
    // match leader bindings without swallowing vim motions.
    expect(
      matchScopedKeybind(Keybind.parse("<leader>f")[0], key("f"), "global", {
        leader: false,
        vimMode: "normal",
      }),
    ).toBe(true)
    // Modifier chords (ctrl/meta/super) are unambiguous application shortcuts
    // and are exempt from normal-mode leader-forcing, so they match their own
    // definitions. This is what lets ctrl+n / ctrl+f / etc. work from normal mode.
    expect(
      matchScopedKeybind(Keybind.parse("ctrl+f")[0], key("f", { ctrl: true }), "global", {
        leader: false,
        vimMode: "normal",
      }),
    ).toBe(true)
    // A modifier chord must not be misattributed to a leader binding.
    expect(
      matchScopedKeybind(Keybind.parse("<leader>f")[0], key("f", { ctrl: true }), "global", {
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
    expect(resolveCommandAlias("subagents")).toBe("session.subagents")
    expect(resolveCommandAlias("subs")).toBe("session.subagents")
    expect(resolveCommandAlias("custom.command")).toBe("custom.command")
  })

  test("returns command suggestions from aliases", () => {
    expect(getCommandSuggestions("mod", 3)).toContain("models")
  })
})

describe("TUI prompt and session input helpers", () => {
  test("leader key enters real normal mode from insert mode", () => {
    const leader = Keybind.parse("ctrl+x")
    expect(getLeaderKeyAction("insert", leader, key("x", { ctrl: true }))).toBe("enter-normal")
    expect(getLeaderKeyAction("normal", leader, key("x", { ctrl: true }))).toBeUndefined()
  })

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

describe("TUI subagent mode guard", () => {
  test("blocks insert mode but permits command mode in subagent sessions", () => {
    const enterInsert = getVimModeTransition("normal", key("i"))!
    const enterCommand = getVimModeTransition("normal", key(":"))!

    expect(isVimModeTransitionAllowed(enterInsert, { subagentReadOnly: true })).toBe(false)
    expect(isVimModeTransitionAllowed(enterCommand, { subagentReadOnly: true })).toBe(true)
  })

  test("keeps normal Vim transitions in main sessions", () => {
    const enterInsert = getVimModeTransition("normal", key("i"))!
    expect(isVimModeTransitionAllowed(enterInsert, { subagentReadOnly: false })).toBe(true)
  })

  test("coerces subagent insert mode back to normal", () => {
    expect(modeForContext("insert", { subagentReadOnly: true })).toBe("normal")
    expect(modeForContext("command", { subagentReadOnly: true })).toBe("command")
    expect(modeForContext("insert", { subagentReadOnly: false })).toBe("insert")
  })
})

describe("TUI permission helpers", () => {
  test("tool permissions use normal-mode enter/y/n controls", () => {
    expect(getToolPermissionResponse("normal", key("return"))).toBe("once")
    expect(getToolPermissionResponse("normal", key("y"))).toBe("always")
    expect(getToolPermissionResponse("normal", key("n"))).toBe("reject")
    expect(getToolPermissionResponse("normal", key("escape"))).toBe("reject")
    expect(getToolPermissionResponse("normal", key("a"))).toBeUndefined()
  })

  test("raw tool permission letters do not fire in insert mode", () => {
    expect(getToolPermissionResponse("insert", key("y"))).toBeUndefined()
    expect(getToolPermissionResponse("insert", key("n"))).toBeUndefined()
    expect(getToolPermissionResponse("insert", key("escape"))).toBeUndefined()
  })

  test("trust prompts use normal-mode enter/y/t/n controls", () => {
    expect(getTrustPermissionResponse("normal", key("return"))).toEqual({ trusted: true, remember: true })
    expect(getTrustPermissionResponse("normal", key("y"))).toEqual({ trusted: true, remember: true })
    expect(getTrustPermissionResponse("normal", key("t"))).toEqual({ trusted: true, remember: false })
    expect(getTrustPermissionResponse("normal", key("n"))).toEqual({ trusted: false, remember: false })
    expect(getTrustPermissionResponse("insert", key("n"))).toBeUndefined()
  })
})

describe("TUI subagent session helpers", () => {
  const sessions = [
    { id: "parent", title: "Main task" },
    { id: "child-b", title: "Explore", parentID: "parent" },
    { id: "other", title: "Other" },
    { id: "child-a", title: "Build", parentID: "parent" },
  ]

  test("builds a deterministic parent plus child session group", () => {
    expect(getSessionGroup(sessions, "child-b").map((item) => item.id)).toEqual(["parent", "child-a", "child-b"])
    expect(getSessionGroup(sessions, "parent").map((item) => item.id)).toEqual(["parent", "child-a", "child-b"])
  })

  test("finds current-session permissions before sibling permissions", () => {
    const permissions = {
      "child-a": [{ id: "per-a" }],
      "child-b": [{ id: "per-b" }],
    }
    expect(getFirstSessionGroupPermission(sessions, "child-b", permissions)).toEqual({
      sessionID: "child-b",
      permission: { id: "per-b" },
    })
  })

  test("marks subagent options with current, permission, and running state", () => {
    const options = buildSubagentSessionOptions({
      sessions,
      currentID: "parent",
      permissions: { "child-a": [{ id: "per-a" }] },
      statuses: { "child-b": { type: "busy" } },
    })

    expect(options.map((item) => item.id)).toEqual(["parent", "child-a", "child-b"])
    expect(options[0]).toMatchObject({ title: "Main: Main task", current: true, parent: true })
    expect(options[1].footer).toBe("1 permission")
    expect(options[2].footer).toBe("busy")
  })

  test("child cycle from parent enters the first child", () => {
    expect(getChildCycleTarget(sessions, "parent", 1)).toBe("child-a")
    expect(getChildCycleTarget(sessions, "parent", -1)).toBe("child-b")
  })

  test("child cycle from a subagent moves through siblings without selecting parent", () => {
    expect(getChildCycleTarget(sessions, "child-a", 1)).toBe("child-b")
    expect(getChildCycleTarget(sessions, "child-b", 1)).toBe("child-a")
    expect(getChildCycleTarget(sessions, "child-a", -1)).toBe("child-b")
  })

  test("subagent read-only state is based on parentID", () => {
    expect(isSubagentSession(sessions[0])).toBe(false)
    expect(isSubagentSession(sessions[1])).toBe(true)
    expect(isSubagentSession(undefined)).toBe(false)
  })

  test("subagent header info is only returned for child sessions", () => {
    expect(getSubagentHeaderInfo(sessions, "child-a")).toEqual({
      index: 1,
      total: 2,
      title: "Build",
    })
    expect(getSubagentHeaderInfo(sessions, "parent")).toBeUndefined()
  })
})

describe("TUI token display helpers", () => {
  test("omits cache ratio when there is no cache activity", () => {
    const tokens = { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(formatCacheHitRatio(tokens)).toBeUndefined()
    expect(formatContextStatus({ tokens, contextLimit: 10_000 })).toBe("1.1K (11%)")
  })

  test("formats cache hit ratio from input plus cache read tokens", () => {
    const tokens = { input: 400, output: 100, reasoning: 0, cache: { read: 600, write: 0 } }
    expect(formatCacheHitRatio(tokens)).toBe("cache 60%")
    expect(formatContextStatus({ tokens, contextLimit: 10_000 })).toBe("1.1K (11%) · cache 60%")
  })

  test("shows cache ratio when only cache writes are reported", () => {
    const tokens = { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 200 } }
    expect(formatCacheHitRatio(tokens)).toBe("cache 0%")
  })
})
