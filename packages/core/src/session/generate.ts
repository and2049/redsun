export * as SessionGenerate from "./generate.js"

import type { AIError } from "@opencode-ai/ai"
import type { Model } from "@opencode-ai/schema/model"
import { Context, type Effect } from "effect"
import type { Instructions } from "../instructions/index.js"
import type { AgentNotFoundError } from "./error.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

export type Error = AgentNotFoundError | Instructions.InitializationBlocked | SessionRunnerModel.Error | AIError

export interface Interface {
  /** Generates text from current Session context without mutating the Session. */
  readonly generate: (input: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: string
    readonly temperature?: number
    /** REDSUN: model override for judge/advisor calls; defaults to the session model. */
    readonly model?: Model.Ref
    /** REDSUN: `false` keeps the tool definitions (cached prefix) but forces toolChoice "none". */
    readonly tools?: boolean
  }) => Effect.Effect<string, Error>
}

/** Location-scoped transient generation from Session context. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGenerate") {}
