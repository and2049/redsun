export * as PermissionMode from "./mode.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Permission } from "@opencode/schema/permission"
import { Context, Effect, Layer, Semaphore } from "effect"
import { KV } from "../kv.js"
import { Bus } from "../bus.js"

export const Mode = Permission.Mode
export type Mode = typeof Mode.Type

const KEY = "permission.mode"

/** REDSUN: `claude_auto` is the pre-rename spelling of `native_auto`; a stored selection survives. */
export const stored = (value: unknown): Mode =>
  value === "auto" ? "auto" : value === "native_auto" || value === "claude_auto" ? "native_auto" : "normal"

export type Listener = (mode: Mode) => Effect.Effect<void>

/**
 * REDSUN: the auto-approve selection is one value for the whole server. `Permission.Service` is
 * built per location, while `/api/permission/mode` is called without a location and lands on the
 * server's working directory; a per-instance copy would leave a session's location on the value it
 * booted with, holding prompts a client believes are auto-approved.
 */
export interface Interface {
  readonly current: () => Effect.Effect<Mode>
  /** Persist a selection and notify every listener, in registration order. */
  readonly set: (mode: Mode) => Effect.Effect<void>
  /** Observe selections made after registration; the returned effect unregisters. */
  readonly listen: (listener: Listener) => Effect.Effect<Effect.Effect<void>>
}

export class Service extends Context.Service<Service, Interface>()("@redsun/PermissionMode") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const bus = yield* Bus.Service
    const lock = yield* Semaphore.make(1)
    let current = stored(yield* kv.get(KEY))
    const listeners = new Set<Listener>()

    const set = Effect.fn("PermissionMode.set")(
      function* (mode: Mode) {
        if (current === mode) return
        yield* kv.set(KEY, mode)
        current = mode
        yield* bus.publish(Permission.Event.ModeChanged, { mode }, { global: true })
        yield* Effect.forEach(Array.from(listeners), (listener) => listener(mode), { discard: true })
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    )

    const listen = (listener: Listener) =>
      Effect.sync(() => {
        listeners.add(listener)
        return Effect.sync(() => {
          listeners.delete(listener)
        })
      })

    return Service.of({ current: () => Effect.sync(() => current), set, listen })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node, Bus.node] })
