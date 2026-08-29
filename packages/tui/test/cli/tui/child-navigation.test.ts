import { expect, test } from "bun:test"
import {
  activeChildren,
  childSessions,
  listWindow,
  nextChild,
  nextInActiveList,
} from "../../../src/routes/session/child-navigation"
import { alignDetails, subagentLabel } from "../../../src/routes/session/subagent-list"

const parent = { id: "ses_a", parentID: undefined }
const first = { id: "ses_b", parentID: "ses_a" }
const second = { id: "ses_c", parentID: "ses_a" }
const third = { id: "ses_d", parentID: "ses_a" }
const family = [third, parent, first, second]

test("lists the children of the family in spawn order, without the parent", () => {
  // `data.session.family` resolves from the family root and returns an
  // unordered list, so the parent has to be dropped and the rest sorted here.
  expect(childSessions(family).map((info) => info.id)).toEqual(["ses_b", "ses_c", "ses_d"])
})

test("cycles siblings and wraps at both ends", () => {
  const children = childSessions(family)
  expect(nextChild(children, "ses_b", 1)?.id).toBe("ses_c")
  expect(nextChild(children, "ses_c", -1)?.id).toBe("ses_b")
  expect(nextChild(children, "ses_d", 1)?.id).toBe("ses_b")
  expect(nextChild(children, "ses_b", -1)?.id).toBe("ses_d")
})

test("goes nowhere when there is nowhere to go", () => {
  const children = childSessions(family)
  // The parent is not a sibling: left and right mean nothing there.
  expect(nextChild(children, "ses_a", 1)).toBeUndefined()
  expect(nextChild(children, undefined, 1)).toBeUndefined()
  // A lone subagent has no sibling to cycle to.
  expect(nextChild(childSessions([parent, first]), "ses_b", 1)).toBeUndefined()
  expect(nextChild([], "ses_b", 1)).toBeUndefined()
})

test("enters the first child from the parent", () => {
  expect(childSessions(family)[0]?.id).toBe("ses_b")
  expect(childSessions([parent])[0]).toBeUndefined()
})

test("the active list keeps only running children", () => {
  const status = (id: string) => (id === "ses_c" ? "running" : "idle")
  expect(activeChildren(childSessions(family), status).map((info) => info.id)).toEqual(["ses_c"])
})

test("arrows walk main and the active children without wrapping", () => {
  const active = [first, third]
  expect(nextInActiveList(active, "ses_a", "ses_a", 1)).toBe("ses_b")
  expect(nextInActiveList(active, "ses_a", "ses_b", 1)).toBe("ses_d")
  expect(nextInActiveList(active, "ses_a", "ses_d", 1)).toBeUndefined()
  expect(nextInActiveList(active, "ses_a", "ses_d", -1)).toBe("ses_b")
  expect(nextInActiveList(active, "ses_a", "ses_b", -1)).toBe("ses_a")
  expect(nextInActiveList(active, "ses_a", "ses_a", -1)).toBeUndefined()
  // A finished child is not in the list: up returns to main, down enters it.
  expect(nextInActiveList(active, "ses_a", "ses_c", -1)).toBe("ses_a")
  expect(nextInActiveList(active, "ses_a", "ses_c", 1)).toBe("ses_b")
})

test("the window scrolls to keep the selected child visible", () => {
  expect(listWindow(-1, 5, 3)).toEqual({ start: 0, end: 3 })
  expect(listWindow(1, 5, 3)).toEqual({ start: 0, end: 3 })
  expect(listWindow(3, 5, 3)).toEqual({ start: 1, end: 4 })
  expect(listWindow(4, 5, 3)).toEqual({ start: 2, end: 5 })
  expect(listWindow(1, 2, 3)).toEqual({ start: 0, end: 2 })
  // Rows below the window drive the "N more" line: 2, then 1, then none at the end.
  expect([1, 3, 4].map((selected) => 5 - listWindow(selected, 5, 3).end)).toEqual([2, 1, 0])
})

test("pads elapsed and token columns so the separators line up", () => {
  expect(
    alignDetails([
      { elapsed: "41s", tokens: "1.0K" },
      { elapsed: "1m 2s", tokens: "568" },
    ]),
  ).toEqual(["  41s · ↓ 1.0K tokens", "1m 2s · ↓  568 tokens"])
  expect(alignDetails([])).toEqual([])
})

test("splits the subagent title into agent and description", () => {
  expect(subagentLabel("Read CLI entry point (@explore subagent)")).toEqual({
    agent: "explore",
    description: "Read CLI entry point",
  })
  expect(subagentLabel("Untitled")).toEqual({ agent: "subagent", description: "Untitled" })
})
