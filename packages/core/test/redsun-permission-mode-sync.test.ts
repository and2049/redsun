import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { PermissionMode } from "@opencode/core/permission/mode"
import { Permission } from "@opencode/schema/permission"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([PermissionMode.node, Bus.node, KV.node])))
it.effect("publishes committed mode changes once for all clients", () =>
  Effect.gen(function* () {
    const mode = yield* PermissionMode.Service
    const bus = yield* Bus.Service
    const kv = yield* KV.Service
    const seen: string[] = []
    yield* bus
      .listen((event) =>
        event.type === Permission.Event.ModeChanged.type
          ? Effect.gen(function* () {
              const data = event.data as { mode: Permission.Mode }
              expect(yield* kv.get("permission.mode")).toBe(data.mode)
              expect(yield* mode.current()).toBe(data.mode)
              seen.push(data.mode)
            })
          : Effect.void,
      )
      .pipe(Effect.flatMap((unsubscribe) => Effect.addFinalizer(() => unsubscribe)))
    yield* mode.set("auto")
    yield* mode.set("auto")
    yield* mode.set("normal")
    expect(seen).toEqual(["auto", "normal"])
  }),
)

const failed = testEffect(
  AppNodeBuilder.build(PermissionMode.node, [
    KV.node.replace(
      Layer.succeed(
        KV.Service,
        KV.Service.of({
          get: () => Effect.succeed("normal"),
          set: () => Effect.die(new Error("storage unavailable")),
          remove: () => Effect.void,
          scan: () => Effect.succeed({ entries: [] }),
        }),
      ),
    ),
  ]),
)
failed.effect("failed persistence does not change effective approval mode", () =>
  Effect.gen(function* () {
    const mode = yield* PermissionMode.Service
    const result = yield* Effect.exit(mode.set("auto"))
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* mode.current()).toBe("normal")
  }),
)
