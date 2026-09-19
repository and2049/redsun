import { expect } from "bun:test"
import { Message, type SystemPart } from "@opencode/ai"
import { Config } from "@opencode/core/config"
import { RedsunAttribution } from "@opencode/core/plugin/redsun/attribution"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

const commitCall = (message: string) =>
  Message.assistant([
    { type: "tool-call", id: "call_1", name: "shell", input: { command: `git commit -m "${message}"` } },
  ])

const attributed = [commitCall(`fix\n\n${RedsunAttribution.DEFAULT_TRAILER}`)]

const run = (commit: boolean | string | undefined, messages: Message[] = []) =>
  Effect.gen(function* () {
    const hooks: Record<string, (event: never) => Effect.Effect<unknown, unknown, never>> = {}
    yield* RedsunAttribution.Plugin.effect(
      host({
        session: {
          hook: ((name: string, callback: (event: never) => Effect.Effect<unknown, unknown, never>) => {
            hooks[name] = callback
            return Effect.void
          }) as never,
        },
      }),
    ).pipe(
      Effect.provideService(Config.Service, {
        entries: () =>
          Effect.succeed(commit === undefined ? [] : ([{ type: "document", info: { attribution: { commit } } }] as never)),
      } as never),
    )
    const system: SystemPart[] = []
    yield* hooks["context"]!({ system, messages, tools: {} } as never)
    return system.map((part) => part.text)
  })

it.effect("adds the default trailer instruction when enabled", () =>
  Effect.gen(function* () {
    const parts = yield* run(true)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toContain(RedsunAttribution.DEFAULT_TRAILER)
  }),
)

it.effect("uses a custom trailer verbatim", () =>
  Effect.gen(function* () {
    const parts = yield* run("Co-authored-by: bot <bot@example.com>")
    expect(parts[0]).toContain("Co-authored-by: bot <bot@example.com>")
    expect(parts[0]).not.toContain("redsun-agent")
  }),
)

it.effect("adds nothing when disabled and the session never attributed", () =>
  Effect.gen(function* () {
    expect(yield* run(undefined)).toEqual([])
    expect(yield* run(false)).toEqual([])
    expect(yield* run("")).toEqual([])
  }),
)

it.effect("counter-instructs when disabled after the session already attributed", () =>
  Effect.gen(function* () {
    const parts = yield* run(false, attributed)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toContain("Do not add a Co-authored-by trailer")
  }),
)

it.effect("ignores trailers that only appear in user text", () =>
  Effect.gen(function* () {
    expect(yield* run(false, [Message.user(`please keep ${RedsunAttribution.DEFAULT_TRAILER}`)])).toEqual([])
  }),
)
