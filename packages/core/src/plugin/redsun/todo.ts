export * as RedsunTodo from "./todo.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"

export const NAME = "todowrite"

export const key = (sessionID: string) => `redsun.todos/${sessionID}`

export const Todo = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
    description: "Current status of the task",
  }),
  priority: Schema.Literals(["high", "medium", "low"]).annotate({
    description: "Priority level of the task",
  }),
})
export type Todo = typeof Todo.Type

export const DESCRIPTION = `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user. Every call replaces the whole list.

## When to use
Use proactively when:
- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive - capture them as todos
- You start a task - mark it \`in_progress\` (only one at a time) before working
- You finish a task - mark it \`completed\` and add any follow-ups discovered during the work

## When NOT to use
Skip when:
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value

## Rules
- Update status in real time; don't batch completions
- Mark \`completed\` only after the required work is actually done, including any required verification. Never based on intent.
- Keep exactly one \`in_progress\` while work remains
- If blocked or partial, keep it \`in_progress\` and add a follow-up todo describing the blocker
- Preserve user-provided commands verbatim (flags, args, order)
- Items should be specific and actionable; break large work into smaller steps

When in doubt, use it.`

export const Plugin = define({
  id: "redsun.tool.todo",
  effect: Effect.fn(function* (ctx) {
    const kv = yield* KV.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: NAME,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Schema.Struct({
            todos: Schema.Array(Todo).annotate({ description: "The updated todo list" }),
          }),
          output: Schema.Struct({ todos: Schema.Array(Todo) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* kv.set(key(context.sessionID), input.todos as never)
              const open = input.todos.filter(
                (todo) => todo.status !== "completed" && todo.status !== "cancelled",
              ).length
              return {
                output: { todos: input.todos },
                content: `${input.todos.length} todo${input.todos.length === 1 ? "" : "s"} (${open} open)`,
                metadata: { todos: input.todos },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
