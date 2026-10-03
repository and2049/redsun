export * as Delegate from "./delegate.js"

// REDSUN: contracts shared by delegated agent runtimes (plugins) and clients.

/** Message metadata on a notice that a runtime answered with a different model than requested. */
export const MODEL_SUBSTITUTED_METADATA_KEY = "redsun.delegate.model-substituted"
