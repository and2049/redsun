import { expect, test } from "bun:test"
import { childSessions, nextChild } from "../../../src/routes/session/child-navigation"

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
