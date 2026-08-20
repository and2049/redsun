import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Environment } from "@opencode-ai/core/environment/index"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Formatter } from "@opencode-ai/core/formatter"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { RedsunMultiedit } from "@opencode-ai/core/plugin/redsun/multiedit"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "./lib/tool"

const multieditToolNode = makeLocationNode({
  name: "test/multiedit-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(RedsunMultiedit.Plugin)),
  deps: [
    Tool.node,
    LocationMutation.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

const sessionID = Session.ID.make("ses_multiedit_tool_test")
const writes: string[] = []
const permission = permissionLayer({ assert: () => Effect.void })
const formatter = Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })

const withTool = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) => {
  writes.length = 0
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* Tool.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([Tool.node, LocationMutation.node, FileMutation.node, multieditToolNode]),
        [
          [
            Environment.node,
            transformEnvironmentFiles(activeLocation, (files) => ({
              write: (target, content) =>
                Effect.sync(() => writes.push(target)).pipe(Effect.andThen(files.write(target, content))),
            })),
          ],
          [Location.node, activeLocation],
          [Formatter.node, formatter],
          [Permission.node, permission],
        ],
      ),
    ),
  )
}

const call = (input: typeof RedsunMultiedit.Input.Type, id = "call-multiedit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "multiedit", input },
})

const it = testEffect(Layer.empty)

const withFile = <A, E, R>(content: string, body: (paths: { dir: string; target: string }) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const target = path.join(tmp.path, "sample.txt")
      return Effect.promise(() => fs.writeFile(target, content)).pipe(
        Effect.andThen(body({ dir: tmp.path, target })),
      )
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("RedsunMultiedit", () => {
  it.live("applies ordered edits sequentially with one write", () =>
    withFile("alpha\nbeta\ngamma\n", ({ dir, target }) =>
      withTool(dir, (registry) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(
            registry,
            call({
              path: "sample.txt",
              edits: [
                { oldString: "alpha", newString: "first" },
                // Sequential semantics: this matches text the first edit produced.
                { oldString: "first\nbeta", newString: "first\nsecond" },
                { oldString: "gamma", newString: "third" },
              ],
            }),
          )
          expect(settled.status).toBe("completed")
          if (settled.status !== "completed") return
          expect(settled.content).toEqual([{ type: "text", text: "Edited sample.txt (3 edits, 3 replacements)" }])
          expect(settled.metadata).toMatchObject({ files: [{ file: "sample.txt", status: "modified" }] })
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("first\nsecond\nthird\n")
          expect(writes).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live("is atomic: a failing edit leaves the file untouched", () =>
    withFile("alpha\nbeta\n", ({ dir, target }) =>
      withTool(dir, (registry) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(
            registry,
            call({
              path: "sample.txt",
              edits: [
                { oldString: "alpha", newString: "first" },
                { oldString: "missing text", newString: "whatever" },
              ],
            }),
          )
          expect(settled.status).toBe("error")
          expect(settled.error?.message).toContain("Edit 2 of 2")
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("alpha\nbeta\n")
          expect(writes).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("reports ambiguity with the occurrence count and honors replaceAll", () =>
    withFile("dup\ndup\nend\n", ({ dir, target }) =>
      withTool(dir, (registry) =>
        Effect.gen(function* () {
          const ambiguous = yield* executeTool(
            registry,
            call({ path: "sample.txt", edits: [{ oldString: "dup", newString: "one" }] }, "call-ambiguous"),
          )
          expect(ambiguous.status).toBe("error")
          expect(ambiguous.error?.message).toContain("found 2 matches")

          const replaced = yield* executeTool(
            registry,
            call({ path: "sample.txt", edits: [{ oldString: "dup", newString: "one", replaceAll: true }] }, "call-all"),
          )
          expect(replaced.status).toBe("completed")
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("one\none\nend\n")
        }),
      ),
    ),
  )
})
