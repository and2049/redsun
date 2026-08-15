import { describe, expect, test } from "bun:test"
import { conversationTargetIds, resolveJump, type JumpMessage, type JumpPart } from "../src/util/message-jump"

describe("conversationTargetIds", () => {
  const partsFor = (parts: Record<string, JumpPart[]>) => (id: string) => parts[id]

  test("user message with real text targets the message id", () => {
    const messages: JumpMessage[] = [{ id: "msg_u1", role: "user" }]
    const parts = { msg_u1: [{ id: "prt_1", type: "text", text: "hello" }] }
    expect(conversationTargetIds(messages, partsFor(parts))).toEqual(["msg_u1"])
  })

  test("skips user messages with only synthetic or empty text", () => {
    const messages: JumpMessage[] = [
      { id: "msg_u1", role: "user" },
      { id: "msg_u2", role: "user" },
      { id: "msg_u3", role: "user" },
    ]
    const parts = {
      msg_u1: [{ id: "prt_1", type: "text", text: "reminder", synthetic: true }],
      msg_u2: [{ id: "prt_2", type: "text", text: "   " }],
      msg_u3: [{ id: "prt_3", type: "file" }],
    }
    expect(conversationTargetIds(messages, partsFor(parts))).toEqual([])
  })

  test("assistant turn targets its first non-empty text part", () => {
    const messages: JumpMessage[] = [{ id: "msg_a1", role: "assistant" }]
    const parts = {
      msg_a1: [
        { id: "prt_r", type: "reasoning", text: "thinking..." },
        { id: "prt_t1", type: "tool" },
        { id: "prt_x", type: "text", text: "" },
        { id: "prt_x2", type: "text", text: "answer" },
        { id: "prt_x3", type: "text", text: "more" },
      ],
    }
    expect(conversationTargetIds(messages, partsFor(parts))).toEqual(["prt_x2"])
  })

  test("skips compaction summaries and tool-only or reasoning-only messages", () => {
    const messages: JumpMessage[] = [
      { id: "msg_s", role: "assistant", summary: true },
      { id: "msg_t", role: "assistant" },
      { id: "msg_r", role: "assistant" },
      { id: "msg_missing", role: "assistant" },
    ]
    const parts = {
      msg_s: [{ id: "prt_s", type: "text", text: "summary text" }],
      msg_t: [{ id: "prt_t", type: "tool" }],
      msg_r: [{ id: "prt_r", type: "reasoning", text: "hmm" }],
    }
    expect(conversationTargetIds(messages, partsFor(parts))).toEqual([])
  })

  test("preserves transcript order across roles", () => {
    const messages: JumpMessage[] = [
      { id: "msg_u1", role: "user" },
      { id: "msg_a1", role: "assistant" },
      { id: "msg_u2", role: "user" },
    ]
    const parts = {
      msg_u1: [{ id: "prt_1", type: "text", text: "question" }],
      msg_a1: [
        { id: "prt_2", type: "tool" },
        { id: "prt_3", type: "text", text: "answer" },
      ],
      msg_u2: [{ id: "prt_4", type: "text", text: "follow-up" }],
    }
    expect(conversationTargetIds(messages, partsFor(parts))).toEqual(["msg_u1", "prt_3", "msg_u2"])
  })
})

describe("resolveJump", () => {
  const offsets = [0, 10, 25, 40]

  test("returns undefined with no targets", () => {
    expect(resolveJump([], 5, "down", 1)).toBeUndefined()
    expect(resolveJump([], 5, "up", 1)).toBeUndefined()
  })

  test("moves to the adjacent target in each direction", () => {
    expect(resolveJump(offsets, 15, "down", 1)).toBe(25)
    expect(resolveJump(offsets, 15, "up", 1)).toBe(10)
  })

  test("repeated single steps advance one turn from a landed target", () => {
    // A jump lands the target at scrollTop + 1, so scrollTop = offset - 1.
    expect(resolveJump(offsets, 10 - 1, "down", 1)).toBe(25)
    expect(resolveJump(offsets, 25 - 1, "up", 1)).toBe(10)
  })

  test("counts multiply the jump", () => {
    // anchor 0: down passes 10, 25, 40
    expect(resolveJump(offsets, -1, "down", 3)).toBe(40)
    // anchor 42: up passes 40, 25
    expect(resolveJump(offsets, 41, "up", 2)).toBe(25)
  })

  test("count overflow clamps to the ends", () => {
    expect(resolveJump(offsets, 5, "down", 99)).toBe(40)
    expect(resolveJump(offsets, 30, "up", 99)).toBe(0)
  })

  test("no target in direction returns undefined", () => {
    expect(resolveJump(offsets, 40, "down", 1)).toBeUndefined()
    expect(resolveJump(offsets, -1, "up", 1)).toBeUndefined()
  })

  test("counts below one are treated as one", () => {
    expect(resolveJump(offsets, 15, "down", 0)).toBe(25)
    expect(resolveJump(offsets, 15, "up", -3)).toBe(10)
  })
})
