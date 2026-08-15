import { describe, expect, test } from "bun:test"
import { COUNT_MAX, pushCount, resolveCommand, transition } from "../src/vim"

describe("vim prompt mode", () => {
  test("supports insert, normal, and command transitions", () => {
    expect(transition("insert", { name: "escape", ctrl: false, meta: false })).toBe("normal")
    expect(transition("normal", { name: "i", ctrl: false, meta: false })).toBe("insert")
    expect(transition("normal", { name: ":", ctrl: false, meta: false })).toBe("command")
    expect(transition("command", { name: "return", ctrl: false, meta: false })).toBe("normal")
  })

  test("resolves TUI command aliases", () => {
    expect(resolveCommand("new")).toBe("session.new")
    expect(resolveCommand("q")).toBe("app.exit")
    expect(resolveCommand("session.compact")).toBe("session.compact")
  })

  test("accumulates count prefixes", () => {
    expect(pushCount(null, 5)).toBe(5)
    expect(pushCount(5, 0)).toBe(50)
    expect(pushCount(1, 2)).toBe(12)
    expect(pushCount(null, 0)).toBeNull()
    expect(pushCount(999, 9)).toBe(COUNT_MAX)
    expect(pushCount(120, 7)).toBe(COUNT_MAX)
  })
})
