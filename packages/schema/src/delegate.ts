export * as Delegate from "./delegate.js"

// REDSUN: contracts shared by delegated agent runtimes (plugins) and clients.

/** Message metadata on a notice that a runtime answered with a different model than requested. */
export const MODEL_SUBSTITUTED_METADATA_KEY = "redsun.delegate.model-substituted"

/** The same notice as written before runtimes were generic; persisted rows still carry it. */
export const LEGACY_MODEL_SUBSTITUTED_METADATA_KEY = "redsun.claude-code.model-substituted"
