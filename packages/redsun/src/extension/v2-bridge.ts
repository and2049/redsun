export * as ExtensionV2Bridge from "./v2-bridge"

import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Cause, Context, Effect, Exit, Layer, Queue, Schema } from "effect"
import * as Scope from "effect/Scope"
import { ExtensionRuntime } from "./runtime"
import { adaptTools } from "./v2-tool-adapter"

/**
 * Registers V1 extension tools and system-context sources into the v2 Location
 * boundaries (`Tools.Service`, `SystemContextRegistry`) so v2 sessions see them.
 * Re-attaches whenever the extension runtime's registrations change (live
 * register/unregister, `/reload`, instance startup); each attach replaces the
 * previous per-directory registration scope, so scoped finalizers give exact
 * last-wins semantics.
 *
 * Known v0 caveats: registrations target the workspace-less Location for the
 * project directory, and the Location service map's idle TTL can rebuild the
 * Location graph after ~60 idle minutes, dropping registrations until the next
 * runtime change or reload. Tool-call/result hook interception and extension
 * commands/UI remain V1-only until upstream ships v2 plugin hooks.
 */

export interface Interface {
  readonly attach: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redsun/ExtensionV2Bridge") {}

const contextEntry = (state: NonNullable<ReturnType<typeof ExtensionRuntime.stateFor>>): SystemContextRegistry.Entry => ({
  key: SystemContext.Key.make("redsun/extension"),
  load: Effect.sync(() =>
    SystemContext.combine(
      Array.from(state.systemContextSources, ([key, loader]) =>
        SystemContext.make({
          key: SystemContext.Key.make(`redsun/extension/${key}`),
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.tryPromise({ try: () => Promise.resolve(loader()), catch: (error) => error }).pipe(
            Effect.catch(() => Effect.succeed(SystemContext.unavailable)),
          ),
          baseline: String,
          update: (_previous, current) => current,
          removed: () => `Extension context source removed: ${key}`,
        }),
      ),
    ),
  ),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const scopes = new Map<string, Scope.Closeable>()

    const attach: Interface["attach"] = (directory) =>
      Effect.gen(function* () {
        const resolved = path.resolve(directory)
        const previous = scopes.get(resolved)
        if (previous) {
          scopes.delete(resolved)
          yield* Scope.close(previous, Exit.void)
        }
        const state = ExtensionRuntime.stateFor(resolved)
        if (!state || state.invalidated) return
        const { tools, skipped } = adaptTools(state.tools, {
          directory: state.directory,
          worktree: state.plugin.worktree,
        })
        if (skipped.length > 0)
          yield* Effect.logWarning("skipping extension tools with invalid v2 names", { skipped })
        const hasTools = Object.keys(tools).length > 0
        const hasContext = state.systemContextSources.size > 0
        if (!hasTools && !hasContext) return
        const scope = yield* Scope.make()
        scopes.set(resolved, scope)
        const located = locations.get(Location.Ref.make({ directory: AbsolutePath.make(resolved) }))
        yield* Effect.gen(function* () {
          if (hasTools) yield* Tools.Service.use((service) => service.register(tools))
          if (hasContext) yield* SystemContextRegistry.Service.use((registry) => registry.register(contextEntry(state)))
        }).pipe(Scope.provide(scope), Effect.provide(located))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("extension v2 bridge attach failed", {
            directory,
            error: String(Cause.squash(cause)),
          }),
        ),
      )

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(scopes.values()), (scope) => Scope.close(scope, Exit.void)).pipe(
        Effect.andThen(Effect.sync(() => scopes.clear())),
      ),
    )

    const queue = yield* Queue.dropping<string>(64)
    const unsubscribe = ExtensionRuntime.onRegistrationsChanged((directory) => {
      Queue.offerUnsafe(queue, directory)
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    yield* Queue.take(queue).pipe(Effect.flatMap(attach), Effect.forever, Effect.forkScoped)
    // Runtimes loaded before this bridge existed (instance boot ordering).
    yield* Effect.forEach(ExtensionRuntime.directories(), attach).pipe(Effect.forkScoped)

    return Service.of({ attach })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [LocationServiceMap.node] })
