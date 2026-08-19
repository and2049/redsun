import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import type { SystemPart } from "@opencode-ai/ai"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Bus } from "@opencode-ai/core/bus"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode-ai/core/instruction-discovery"
import { Location } from "@opencode-ai/core/location"
import { RedsunProjectMemory } from "@opencode-ai/core/plugin/redsun/project-memory"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { readInitial } from "./lib/instructions"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

const memoryLayer = (input: { directory: string; project?: boolean }) => {
  const watcher = Watcher.testLayer
  const ref = Location.Ref.make({ directory: AbsolutePath.make(input.directory) })
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([InstructionDiscovery.node, Bus.node, FSUtil.node, Global.node, Location.node, Watcher.node]),
      [
        [InstructionDiscovery.node, InstructionDiscovery.configured({ project: input.project })],
        [Global.node, tempGlobalLayer],
        [Location.node, Layer.succeed(Location.Service, Location.Service.of(location(ref)))],
        [Watcher.node, watcher],
      ],
    ),
    watcher,
  )
}

/** Collects the system parts the plugin's context hook contributes. */
const systemParts: SystemPart[] = []

const start = Effect.fnUntraced(function* () {
  systemParts.length = 0
  const hooks: Record<string, (event: never) => Effect.Effect<unknown, unknown, never>> = {}
  yield* RedsunProjectMemory.Plugin.effect(
    host({
      session: {
        hook: ((name: string, callback: (event: never) => Effect.Effect<unknown, unknown, never>) => {
          hooks[name] = callback
          return Effect.void
        }) as never,
      },
    }),
  )
  return {
    discovery: yield* InstructionDiscovery.Service,
    context: () =>
      Effect.gen(function* () {
        const callback = hooks["context"]
        if (!callback) return systemParts
        yield* callback({ system: systemParts, messages: [], tools: {} } as never)
        return systemParts
      }),
  }
})

const withProject = <A, E, R>(
  body: (paths: { readonly directory: string; readonly memory: string }) => Effect.Effect<A, E, R>,
  options?: { readonly project?: boolean },
) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir("redsun-project-memory-")),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const memory = path.join(tmp.path, RedsunProjectMemory.RELATIVE_PATH)
    yield* Effect.promise(() => fs.mkdir(path.dirname(memory), { recursive: true }))
    return yield* body({ directory: tmp.path, memory }).pipe(
      Effect.provide(memoryLayer({ directory: tmp.path, ...options })),
    )
  }).pipe(Effect.scoped)

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const updated = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

describe("RedsunProjectMemory", () => {
  it.live("loads .redsun/memory.md from the project root", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(memory, "the compaction rework is load-bearing"))
        const { discovery } = yield* start()

        expect((yield* readInitial(yield* discovery.load())).text).toContain(
          "the compaction rework is load-bearing",
        )
      }),
    ),
  )

  it.live("contributes nothing when the project has no memory file", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        const { discovery, context } = yield* start()
        expect((yield* readInitial(yield* discovery.load())).text).not.toContain(memory)
        // The policy would only invite a memory file to be invented.
        expect(yield* context()).toHaveLength(0)
      }),
    ),
  )

  it.live("does not load project memory when project instructions are disabled", () =>
    withProject(
      ({ memory }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(memory, "should stay unread"))
          const { discovery } = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).not.toContain("should stay unread")
        }),
      { project: false },
    ),
  )

  it.live("watches the memory file so an edit lands without a restart", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(memory, "original note"))
        const { discovery } = yield* start()
        const watcher = yield* Watcher.Test
        expect(yield* watcher.subscriptions()).toContainEqual({ path: memory, type: "file" })

        yield* Effect.promise(() => fs.writeFile(memory, "revised note"))
        yield* emitAndWait({ type: "update", path: memory })

        expect((yield* readInitial(yield* discovery.load())).text).toContain("revised note")
      }),
    ),
  )

  it.live("picks up a memory file created after startup", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        // The watch must be registered even though the file is absent, or
        // creating one would need a restart.
        const { discovery } = yield* start()
        const watcher = yield* Watcher.Test
        expect(yield* watcher.subscriptions()).toContainEqual({ path: memory, type: "file" })

        yield* Effect.promise(() => fs.writeFile(memory, "written later"))
        yield* emitAndWait({ type: "update", path: memory })

        expect((yield* readInitial(yield* discovery.load())).text).toContain("written later")
      }),
    ),
  )

  it.live("adds the maintenance policy only when memory exists", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(memory, "a note"))
        const { context } = yield* start()

        const parts = yield* context()
        expect(parts).toHaveLength(1)
        // The policy lives in the system prompt, not in the file, so the agent
        // never edits the rules it is being given.
        expect(parts[0]?.text).toContain(RedsunProjectMemory.RELATIVE_PATH)
        expect(parts[0]?.text).toContain("<project_memory>")
      }),
    ),
  )

  it.effect("registers under a redsun-owned plugin id", () =>
    Effect.sync(() => {
      expect(RedsunProjectMemory.Plugin.id).toBe("redsun.instruction.project-memory")
    }),
  )
})
