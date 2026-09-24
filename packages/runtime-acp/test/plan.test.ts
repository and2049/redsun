import { describe, expect, test } from "bun:test"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { AcpPlan } from "../src/plan.js"

const entry = (content: string, status = "pending") => ({ content, status, priority: "medium" }) as never

describe("agent plans as the host's todo list", () => {
  test("joins plans by id, ignores non-list plans, and drops removed ones", () => {
    const plans: AcpPlan.Plans = new Map()
    const apply = (update: unknown) => AcpPlan.apply(plans, update as SessionUpdate)
    expect(
      apply({ sessionUpdate: "plan_update", plan: { type: "items", planId: "a", entries: [entry("one")] } }),
    ).toEqual([{ content: "one", status: "pending", priority: "medium" }])
    expect(
      apply({ sessionUpdate: "plan_update", plan: { type: "items", planId: "b", entries: [entry("two", "odd")] } }),
    ).toEqual([
      { content: "one", status: "pending", priority: "medium" },
      { content: "two", status: "pending", priority: "medium" },
    ])
    expect(apply({ sessionUpdate: "plan_update", plan: { type: "markdown", planId: "c", content: "# notes" } })).toBe(
      undefined,
    )
    expect(apply({ sessionUpdate: "plan_removed", planId: "a" })).toEqual([
      { content: "two", status: "pending", priority: "medium" },
    ])
    expect(apply({ sessionUpdate: "plan_removed", planId: "a" })).toBe(undefined)
    expect(apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })).toBe(undefined)
  })
})
