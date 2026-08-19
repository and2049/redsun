import { expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

test("binds agent cycling to tab, leaving shift+tab to auto-approve", () => {
  expect(TuiKeybind.Definitions["agent.cycle"].default).toBe("tab")
  expect(TuiKeybind.Definitions["permission.mode"].default).toBe("shift+tab")
  expect(TuiKeybind.Definitions["agent.cycle.reverse"].default).toBe("none")
})
