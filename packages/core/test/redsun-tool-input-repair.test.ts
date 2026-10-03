import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { RedsunMultiedit } from "@opencode/core/plugin/redsun/multiedit"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// Upstream repairs tool input in an execute.before hook against the live registry. Redsun runs
// the same repair inside Tool.executeTool, against the definition the request captured, after
// its own legacy single-edit fold.

const it = testEffect(PluginTestLayer)
const identity = {
  sessionID: Session.ID.make("ses_repair"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_repair"),
}

const run = (name: string, input: unknown) => ({
  ...identity,
  call: { type: "tool-call" as const, id: "call-repair", name, input },
})

it.effect("folds a legacy multiedit call before schema repair prunes its keys", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const seen: unknown[] = []
    yield* registry.transform((draft) =>
      draft.add({
        name: "multiedit",
        description: "Repair fixture",
        options: { codemode: false },
        input: RedsunMultiedit.Input,
        execute: (input) => Effect.sync(() => (seen.push(input), { content: "ok" })),
      }),
    )
    const snapshot = yield* registry.snapshot()
    yield* snapshot.execute(run("multiedit", { path: "a.ts", oldString: "a", newString: "b", replaceAll: true }))
    expect(seen).toEqual([{ path: "a.ts", edits: [{ oldString: "a", newString: "b", replaceAll: true }] }])
  }),
)

it.effect("repairs against the captured schema when the registry changes mid-request", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const seen: unknown[] = []
    yield* registry.transform((draft) =>
      draft.add({
        name: "review",
        description: "Repair fixture",
        options: { codemode: false },
        input: Schema.Struct({ value: Schema.String }),
        execute: (input) => Effect.sync(() => (seen.push(input), { content: "ok" })),
      }),
    )
    const snapshot = yield* registry.snapshot()
    yield* registry.transform((draft) =>
      draft.update("review", (tool) => {
        tool.input = Schema.Struct({ value: Schema.Boolean })
      }),
    )
    yield* snapshot.execute(run("review", { value: "false" }))
    expect(seen).toEqual([{ value: "false" }])
  }),
)

it.effect("still applies upstream's schema repair without the hook plugin", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const seen: unknown[] = []
    yield* registry.transform((draft) =>
      draft.add({
        name: "count",
        description: "Repair fixture",
        options: { codemode: false },
        input: Schema.Struct({ limit: Schema.Int, enabled: Schema.Boolean }),
        execute: (input) => Effect.sync(() => (seen.push(input), { content: "ok" })),
      }),
    )
    const snapshot = yield* registry.snapshot()
    yield* snapshot.execute(run("count", '{"limit":"20","enabled":"false","extra":true}'))
    expect(seen).toEqual([{ limit: 20, enabled: false }])
  }),
)
