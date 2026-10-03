export * as RedsunTodo from "./todo.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { KV } from "../../kv.js"

export const NAME = "todowrite"

export const key = (sessionID: string) => `redsun.todos/${sessionID}`

// Field names are self-describing; the tool description carries the rules. Each schema byte is
// resent on every request, and every required field is written on every item of every call.
const Item = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
})

export const Todo = Schema.Struct({
  ...Item.fields,
  children: Schema.optionalKey(Schema.Array(Item)),
})
export type Todo = typeof Todo.Type

export const flatten = (todos: ReadonlyArray<Todo>) => todos.flatMap((todo) => [todo, ...(todo.children ?? [])])

// A todo-only step resends the whole context, so updates ride along with the next real tool call.
export const DESCRIPTION = `Maintain the session's task list; the user sees it live. Each call replaces the whole list.

Use it proactively for work with 3+ steps, multiple user requests, or new instructions mid-task. Skip it for single-step or purely conversational requests. When in doubt, use it.

- Keep exactly one item \`in_progress\`, set before you start it.
- Mark \`completed\` only after the work, including verification, is done. If blocked, keep it open and add an item for the blocker.
- Keep items specific; copy user-given commands verbatim. Nest sub-steps under \`children\` (one level); a parent stays open until its children finish.
- Never spend a turn only on the list: send each update alongside your next tool call.`

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
            todos: Schema.Array(Todo),
          }),
          output: Schema.Struct({ todos: Schema.Array(Todo) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* kv.set(key(context.sessionID), input.todos as never)
              const all = flatten(input.todos)
              const open = all.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length
              return {
                output: { todos: input.todos },
                content: `${all.length} todo${all.length === 1 ? "" : "s"} (${open} open)`,
                metadata: { todos: input.todos },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
