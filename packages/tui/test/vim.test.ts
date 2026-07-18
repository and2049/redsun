import { describe, expect, test } from "bun:test"
import { resolveCommand, transition } from "../src/vim"

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
})
