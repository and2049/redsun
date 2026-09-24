export * as DelegatedRuntime from "./delegate.js"

// REDSUN: registry of delegated agent runtimes (see @opencode/plugin/effect/delegate). Core asks
// `owns(model)` instead of knowing any runtime by name, and bridges each registered runtime into a
// language model so the normal request path (hooks, LLMEvent conversion, publishing) is unchanged.

import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { DelegatedTurn, DelegatedRuntime as Definition } from "@opencode/plugin/effect/delegate"
import type { SessionModelRequest } from "@opencode/plugin/effect/session"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { State } from "./state.js"

export type Runtime = Definition
export type Turn = DelegatedTurn

export const DEFAULT_COMPACTION_NOTICE =
  "This model's agent runtime manages its own context; compaction does not apply."

/**
 * Turn identity rides on request headers from `prepare` to the bridge, because the AI SDK call is
 * the only channel through the route. These are core-internal: added only for owned providers and
 * stripped before the runtime sees the options. Session and parent use the upstream headers.
 */
export const Headers = {
  session: "x-opencode-session",
  parent: "x-parent-session-id",
  agent: "x-redsun-delegate-agent",
  kind: "x-redsun-delegate-kind",
  message: "x-redsun-delegate-message",
} as const

const INTERNAL = new Set<string>([Headers.agent, Headers.kind, Headers.message])
const KINDS = new Set<string>(["primary", "compaction", "title", "generate"])

/** `session.model.request` hook body for an owned provider: tag the request with its identity. */
export const tagRequest = (event: SessionModelRequest) =>
  Effect.sync(() => {
    event.headers[Headers.agent] = event.agent
    event.headers[Headers.kind] = event.kind
  })

const header = (headers: LanguageModelV3CallOptions["headers"], name: string) => {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name && value) return value
  return undefined
}

/** Reads the turn identity core attached, and the options without the internal headers. */
export const decode = (
  modelID: string,
  options: LanguageModelV3CallOptions,
): { readonly turn?: Turn; readonly options: LanguageModelV3CallOptions } => {
  const sessionID = header(options.headers, Headers.session)
  const agent = header(options.headers, Headers.agent)
  const kind = header(options.headers, Headers.kind)
  const parentID = header(options.headers, Headers.parent)
  const assistantMessageID = header(options.headers, Headers.message)
  const headers = options.headers
    ? Object.fromEntries(Object.entries(options.headers).filter(([key]) => !INTERNAL.has(key.toLowerCase())))
    : undefined
  const stripped = { ...options, headers }
  if (!sessionID || !agent || !kind || !KINDS.has(kind)) return { options: stripped }
  return {
    turn: {
      sessionID,
      agent,
      kind: kind as Turn["kind"],
      modelID,
      ...(parentID ? { parentID } : {}),
      ...(assistantMessageID ? { assistantMessageID } : {}),
    },
    options: stripped,
  }
}

/**
 * The language model the AI SDK route drives for one of a runtime's models. The runtime is looked
 * up per call, so a cached model follows re-registration and fails cleanly after removal.
 */
export const language = (
  model: { readonly providerID: string; readonly modelID: string },
  lookup: (providerID: string) => Runtime | undefined,
): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: model.providerID,
  modelId: model.modelID,
  supportedUrls: {},
  doStream: async (options) => {
    const runtime = lookup(model.providerID)
    if (!runtime) throw new Error(`No delegated runtime is registered for provider ${model.providerID}.`)
    const decoded = decode(model.modelID, options)
    if (!decoded.turn)
      throw new Error(`The ${runtime.id} runtime requires a session request; this request carried no turn identity.`)
    return runtime.turn(decoded.turn, decoded.options)
  },
  doGenerate: async () => {
    throw new Error(`Delegated runtime models (${model.providerID}) do not support non-streaming generation.`)
  },
})

export type Editor = {
  add: (runtime: Runtime) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (model: { readonly providerID: string }) => Effect.Effect<Runtime | undefined>
  readonly owns: (model: { readonly providerID: string }) => Effect.Effect<boolean>
  /** Synchronous lookup for the language-model bridge. */
  readonly lookup: (providerID: string) => Runtime | undefined
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
  const lookup = (providerID: string) => state.get().get(providerID)
  const get = (model: { readonly providerID: string }) => Effect.sync(() => lookup(model.providerID))
  return Service.of({
    transform: state.transform,
    reload: state.reload,
    lookup,
    get,
    owns: (model) => get(model).pipe(Effect.map((runtime) => runtime !== undefined)),
  })
}

export const layer = Layer.effect(Service, Effect.sync(make))

export const node = makeLocationNode({ service: Service, layer, deps: [] })
