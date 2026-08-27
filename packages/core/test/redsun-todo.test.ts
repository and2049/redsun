import { expect } from "bun:test"
import { KV } from "@opencode-ai/core/kv"
import { RedsunTodo, key } from "@opencode-ai/core/plugin/redsun/todo"
import { Session } from "@opencode-ai/core/session"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)
const sessionID = Session.ID.make("ses_redsun_todo")

it.effect("todowrite registers through the real entry point and persists the list", () =>
  Effect.gen(function* () {
    const kvStore = new Map<string, unknown>()
    const kv: KV.Interface = {
      get: (k) => Effect.succeed(kvStore.get(k) as never),
      set: (k, value) => Effect.sync(() => void kvStore.set(k, value)),
      remove: (k) => Effect.sync(() => void kvStore.delete(k)),
      scan: () => Effect.succeed({ entries: [] }),
    }
    let definition: {
      name: string
      description: string
      execute: (input: unknown, context: { sessionID: Session.ID }) => Effect.Effect<unknown, unknown, never>
    }
    yield* RedsunTodo.Plugin.effect(
      host({
        tool: {
          transform: ((callback: (draft: { add: (value: never) => void }) => void) => {
            callback({ add: ((value: never) => void (definition = value as never)) as never })
            return Effect.void
          }) as never,
          hook: () => Effect.die("unused tool.hook"),
          reload: (() => Effect.void) as never,
        },
      }),
    ).pipe(Effect.provide(Layer.mock(KV.Service)(kv)))

    expect(definition!.name).toBe("todowrite")
    expect(definition!.description).toContain("task list")

    const todos = [
      { content: "port the extractor", status: "completed", priority: "high" },
      { content: "wire the strategies", status: "in_progress", priority: "high" },
      { content: "write the tests", status: "pending", priority: "medium" },
    ]
    const result = (yield* definition!.execute({ todos }, { sessionID })) as {
      output: { todos: unknown[] }
      content: string
      metadata: { todos: unknown[] }
    }
    expect(result.content).toBe("3 todos (2 open)")
    expect(result.metadata.todos).toEqual(todos)
    expect(kvStore.get(key(sessionID))).toEqual(todos)

    const emptied = (yield* definition!.execute({ todos: [] }, { sessionID })) as { content: string }
    expect(emptied.content).toBe("0 todos (0 open)")
    expect(kvStore.get(key(sessionID))).toEqual([])
  }),
)
