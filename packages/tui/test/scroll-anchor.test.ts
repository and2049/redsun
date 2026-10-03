import { expect, test } from "bun:test"
import { forgetScrollAnchor, scrollAnchor, setScrollAnchor } from "../src/routes/session/scroll-anchor"

test("keeps parent and subagent scroll anchors independent", () => {
  const parent = { messageID: "msg_parent", screenY: -3 }
  const child = { messageID: "msg_child", screenY: -5 }
  try {
    setScrollAnchor("anchor-parent", parent)
    setScrollAnchor("anchor-child", undefined)
    expect(scrollAnchor("anchor-parent")).toEqual(parent)
    expect(scrollAnchor("anchor-child")).toBeUndefined()
    setScrollAnchor("anchor-child", child)
    expect(scrollAnchor("anchor-parent")).toEqual(parent)
    expect(scrollAnchor("anchor-child")).toEqual(child)
    setScrollAnchor("anchor-parent", undefined)
    expect(scrollAnchor("anchor-child")).toEqual(child)
  } finally {
    forgetScrollAnchor("anchor-parent")
    forgetScrollAnchor("anchor-child")
  }
})
