export * as AcpPlan from "./plan.js"

import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk"

// An agent's plan as the host's todo list. ACP reports a plan as a whole list (`plan`), or as
// several plans by id (`plan_update`, `plan_removed`) of which only item lists are todos. Either
// way the host's todo list is replaced, as its own todowrite tool does.

export interface Todo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed" | "cancelled"
  readonly priority: "high" | "medium" | "low"
}

/** The host tool that owns the todo list. */
export const TOOL = "todowrite"

/** The id the classic whole-list `plan` update stands under. */
const WHOLE = ""

const STATUS = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITY = new Set(["high", "medium", "low"])

const todo = (entry: PlanEntry): Todo => ({
  content: entry.content,
  status: STATUS.has(entry.status) ? (entry.status as Todo["status"]) : "pending",
  priority: PRIORITY.has(entry.priority) ? (entry.priority as Todo["priority"]) : "medium",
})

/** A session's current plans, by plan id. */
export type Plans = Map<string, readonly Todo[]>

/** Applies a plan update; returns the whole todo list when it changed. */
export const apply = (plans: Plans, update: SessionUpdate): readonly Todo[] | undefined => {
  const before = JSON.stringify([...plans])
  if (update.sessionUpdate === "plan") plans.set(WHOLE, update.entries.map(todo))
  else if (update.sessionUpdate === "plan_update" && update.plan.type === "items")
    plans.set(update.plan.planId, update.plan.entries.map(todo))
  else if (update.sessionUpdate === "plan_removed") plans.delete(update.planId)
  else return undefined
  if (JSON.stringify([...plans]) === before) return undefined
  return [...plans.values()].flat()
}
