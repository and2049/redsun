import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { RedsunMultiedit } from "@opencode/core/plugin/redsun/multiedit"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// Upstream repairs tool input in an execute.before hook against the live registry. Redsun runs
// the same repair inside Tool.executeTool, against the definition the request captured. The
// multiedit's LegacyFoldPlugin folds the legacy single-edit shape in an execute.before hook,
// which runs before that repair prunes the undeclared oldString/newString keys.

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

const multiedit = (seen: unknown[]) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    yield* registry.transform((draft) =>
      draft.add({
        name: "multiedit",
        description: "Repair fixture",
        options: { codemode: false },
        input: RedsunMultiedit.Input,
        execute: (input) => Effect.sync(() => (seen.push(input), { content: "ok" })),
      }),
    )
    return yield* registry.snapshot()
  })

describe("foldLegacyEdit", () => {
  test("folds the single-edit shape into edits[]", () => {
    expect(RedsunMultiedit.foldLegacyEdit({ path: "a.ts", oldString: "a", newString: "b", replaceAll: true })).toEqual({
      path: "a.ts",
      edits: [{ oldString: "a", newString: "b", replaceAll: true }],
    })
    expect(RedsunMultiedit.foldLegacyEdit({ path: "a.ts", oldString: "a", newString: "b" })).toEqual({
      path: "a.ts",
      edits: [{ oldString: "a", newString: "b" }],
    })
  })

  test("leaves anything else alone", () => {
    const current = { path: "a.ts", edits: [], oldString: "a", newString: "b" }
    expect(RedsunMultiedit.foldLegacyEdit(current)).toBe(current)
    expect(RedsunMultiedit.foldLegacyEdit({ path: "a.ts", oldString: "a" })).toEqual({ path: "a.ts", oldString: "a" })
    expect(RedsunMultiedit.foldLegacyEdit("text")).toBe("text")
  })
})

it.effect("folds a legacy multiedit call before schema repair prunes its keys", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    yield* plugins.activate([{ ...RedsunMultiedit.LegacyFoldPlugin, revision: "1" }])
    const seen: unknown[] = []
    const snapshot = yield* multiedit(seen)
    yield* snapshot.execute(run("multiedit", { path: "a.ts", oldString: "a", newString: "b", replaceAll: true }))
    expect(seen).toEqual([{ path: "a.ts", edits: [{ oldString: "a", newString: "b", replaceAll: true }] }])
  }),
)

it.effect("parses a double-encoded edits array through the schema repair", () =>
  Effect.gen(function* () {
    const seen: unknown[] = []
    const snapshot = yield* multiedit(seen)
    yield* snapshot.execute(run("multiedit", { path: "a.ts", edits: '[{"oldString":"a","newString":"b"}]' }))
    expect(seen).toEqual([{ path: "a.ts", edits: [{ oldString: "a", newString: "b" }] }])
  }),
)

it.effect("rejects a legacy multiedit call when the fold hook is absent", () =>
  Effect.gen(function* () {
    const seen: unknown[] = []
    const snapshot = yield* multiedit(seen)
    const exit = yield* snapshot
      .execute(run("multiedit", { path: "a.ts", oldString: "a", newString: "b" }))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(seen).toEqual([])
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
