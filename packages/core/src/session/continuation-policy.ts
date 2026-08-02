export * as SessionContinuationPolicy from "./continuation-policy"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

/**
 * Consulted when a drain is about to settle: tool continuation is finished and no steer
 * or queued input is pending. Implementations may durably admit new session input
 * (`SessionInput.admit`) to extend the drain; the runner re-checks pending steers after
 * `onSettle` returns. Implementations must not fail the drain — handle errors internally.
 */
export interface Interface {
  readonly onSettle: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionContinuationPolicy") {}

export const noopLayer = Layer.succeed(Service, Service.of({ onSettle: () => Effect.void }))

export const node = makeLocationNode({ service: Service, layer: noopLayer, deps: [] })
