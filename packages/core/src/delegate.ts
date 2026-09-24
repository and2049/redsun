export * as DelegatedRuntime from "./delegate.js"

// REDSUN: registry of delegated agent runtimes (see @opencode/plugin/effect/delegate). Core asks
// `owns(model)` instead of knowing any runtime by name.

import type { DelegatedRuntime as Definition } from "@opencode/plugin/effect/delegate"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { State } from "./state.js"

export type Runtime = Definition

export const DEFAULT_COMPACTION_NOTICE =
  "This model's agent runtime manages its own context; compaction does not apply."

export type Editor = {
  add: (runtime: Runtime) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (model: { readonly providerID: string }) => Effect.Effect<Runtime | undefined>
  readonly owns: (model: { readonly providerID: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@redsun/DelegatedRuntime") {}

export const make = (): Interface => {
  const state = State.create<Map<string, Runtime>, Editor>({
    name: "DelegatedRuntime",
    initial: () => new Map(),
    editor: (runtimes) => ({
      add: (runtime) => runtimes.set(runtime.providerID, runtime),
    }),
  })
  const get = (model: { readonly providerID: string }) => Effect.sync(() => state.get().get(model.providerID))
  return Service.of({
    transform: state.transform,
    reload: state.reload,
    get,
    owns: (model) => get(model).pipe(Effect.map((runtime) => runtime !== undefined)),
  })
}

export const layer = Layer.effect(Service, Effect.sync(make))

export const node = makeLocationNode({ service: Service, layer, deps: [] })
