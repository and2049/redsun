import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, PubSub, Schema, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import type { SystemPart } from "@opencode/ai"
import { Document, Info as ConfigInfo } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { RedsunProjectMemory } from "@opencode/core/plugin/redsun/project-memory"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { readInitial } from "./lib/instructions"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

type Load = "outline" | "full"
/** A function stands in for config the test flips after startup. */
type Options = { readonly project?: boolean; readonly load?: Load | (() => Load | undefined) }

const memoryLayer = (input: { directory: string } & Options) => {
  const watcher = Watcher.testLayer
  const ref = Location.Ref.make({ directory: AbsolutePath.make(input.directory) })
  const load = () => (typeof input.load === "function" ? input.load() : input.load)
  const info = () => Schema.decodeUnknownSync(ConfigInfo)(load() ? { project_memory: { load: load() } } : {})
  return Layer.mergeAll(
    Layer.mock(Config.Service)({
      entries: () => Effect.sync(() => [new Document({ type: "document", info: info() })]),
    }),
    AppNodeBuilder.build(
      LayerNode.group([InstructionDiscovery.node, Bus.node, FSUtil.node, Global.node, Location.node, Watcher.node]),
      [
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: input.project })),
        Global.node.replace(tempGlobalLayer),
        Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location(ref)))),
        Watcher.node.replace(watcher),
      ],
    ),
    watcher,
  )
}

/** Collects the system parts the plugin's context hook contributes. */
const systemParts: SystemPart[] = []

const start = Effect.fnUntraced(function* (events?: Stream.Stream<{ readonly type: string }>) {
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
      ...(events ? { event: { subscribe: () => events as never } } : {}),
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
  options?: Options,
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

const { outline } = RedsunProjectMemory
const FILE = "/repo/.redsun/memory.md"
const filler = (lines: number) => Array.from({ length: lines }, (_, index) => `detail ${index} ${"x".repeat(80)}`)
const document = [
  "# Project Memory",
  "",
  "Release with: git push origin dev:latest",
  "",
  "## Architecture",
  ...filler(40),
  "",
  "## Features",
  "",
  "### Compaction",
  ...filler(30),
  "```md",
  "## Not a heading",
  "```",
  "",
  "### Plan mode",
  ...filler(20),
  "",
  "## Known gaps",
  ...filler(10),
  "",
].join("\n")

describe("RedsunProjectMemory.outline", () => {
  const lines = document.split("\n")
  const at = (text: string) => lines.indexOf(text) + 1

  it.effect("indexes the top two heading levels with section line ranges", () =>
    Effect.sync(() => {
      const result = outline(document, FILE)
      expect(result).toContain(`[redsun: outline of ${FILE} (${lines.length - 1} lines).`)
      expect(result).toContain("Release with: git push origin dev:latest")
      expect(result).toContain(`- Architecture (lines ${at("## Architecture")}-${at("## Features") - 2})`)
      expect(result).toContain(`- Features (lines ${at("## Features")}-${at("## Known gaps") - 2})`)
      expect(result).toContain(`  - Compaction (lines ${at("### Compaction")}-${at("### Plan mode") - 2})`)
      expect(result).toContain(`- Known gaps (lines ${at("## Known gaps")}-${lines.length - 1})`)
      expect(result).not.toContain("Not a heading")
      expect(result).not.toContain("detail 0")
      expect(result.length).toBeLessThan(document.length / 5)
    }),
  )

  it.effect("returns small or heading-less documents unchanged", () =>
    Effect.sync(() => {
      expect(outline("## Only\nshort", FILE)).toBe("## Only\nshort")
      const flat = filler(200).join("\n")
      expect(outline(flat, FILE)).toBe(flat)
    }),
  )

  it.effect("truncates a long preamble with a pointer to its lines", () =>
    Effect.sync(() => {
      const long = [...filler(40), "## Section", ...filler(200)].join("\n")
      const result = outline(long, FILE)
      expect(result).toContain("[preamble truncated; read lines 1-40]")
      expect(result).toContain("- Section (lines 41-241)")
      expect(result.length).toBeLessThan(RedsunProjectMemory.OUTLINE_PREAMBLE_MAX_CHARS + 500)
    }),
  )

  it.effect("cuts a top level that still does not fit at an entry boundary", () =>
    Effect.sync(() => {
      const many = [
        "# Title",
        ...Array.from({ length: 400 }, (_, index) => [`## Top heading number ${index}`, "body"]).flat(),
      ].join("\n")
      const result = outline(many, FILE)
      const sections = result.slice(result.indexOf("Sections:\n") + "Sections:\n".length)
      expect(sections.length).toBeLessThan(RedsunProjectMemory.OUTLINE_INDEX_MAX_CHARS + 200)
      expect(sections).toMatch(
        /\[index truncated: \d+ more sections\. List them with grep: \^#\{1,2\} \/repo\/\.redsun\/memory\.md\]$/,
      )
      const listed = sections.split("\n").filter((line) => line.startsWith("- ")).length
      const dropped = Number(sections.match(/index truncated: (\d+)/)![1])
      expect(listed + dropped).toBe(400)
      expect(sections).not.toContain("- Top heading number 399")
    }),
  )

  it.effect("drops the nested level when the index is too large", () =>
    Effect.sync(() => {
      const many = [
        "## Top",
        ...Array.from({ length: 400 }, (_, index) => [`### Nested heading number ${index}`, "body"]).flat(),
      ].join("\n")
      const result = outline(many, FILE)
      expect(result).toContain("- Top (lines 1-")
      expect(result).not.toContain("Nested heading number")
    }),
  )
})

describe("RedsunProjectMemory", () => {
  it.live("loads .redsun/memory.md from the project root", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(memory, "the compaction rework is load-bearing"))
        const { discovery } = yield* start()

        expect((yield* readInitial(yield* discovery.load())).text).toContain("the compaction rework is load-bearing")
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

  it.live("loads large memory as an outline by default", () =>
    withProject(({ memory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(memory, document))
        const { discovery } = yield* start()
        const text = (yield* readInitial(yield* discovery.load())).text
        expect(text).toContain(`[redsun: outline of ${memory}`)
        expect(text).toContain("  - Plan mode (lines")
        expect(text).not.toContain("detail 0")
      }),
    ),
  )

  it.live("loads large memory in full when configured", () =>
    withProject(
      ({ memory }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(memory, document))
          const { discovery } = yield* start()
          const text = (yield* readInitial(yield* discovery.load())).text
          expect(text).toContain("detail 0")
          expect(text).not.toContain("[redsun: outline of")
        }),
      { load: "full" },
    ),
  )

  it.live("re-projects memory when the load mode flips in config, without a memory edit", () =>
    Effect.gen(function* () {
      const live = { load: "outline" as Load }
      yield* withProject(
        ({ memory }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(memory, document))
            const events = yield* PubSub.unbounded<{ readonly type: string }>()
            const { discovery } = yield* start(Stream.fromPubSub(events))
            expect((yield* readInitial(yield* discovery.load())).text).toContain("[redsun: outline of")

            const bus = yield* Bus.Service
            const updated = yield* Deferred.make<void>()
            const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
              Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
              Effect.forkScoped,
            )
            yield* Effect.yieldNow
            // An unrelated config edit changes nothing and must not reload instructions.
            yield* PubSub.publish(events, { type: "config.updated" })
            yield* Effect.sleep("50 millis")
            expect(yield* Deferred.isDone(updated)).toBe(false)

            live.load = "full"
            yield* PubSub.publish(events, { type: "config.updated" })
            yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
            yield* Fiber.interrupt(fiber)
            const text = (yield* readInitial(yield* discovery.load())).text
            expect(text).toContain("detail 0")
            expect(text).not.toContain("[redsun: outline of")
          }),
        { load: () => live.load },
      )
    }),
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
