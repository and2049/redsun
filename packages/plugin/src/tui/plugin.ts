import type { Context } from "./context.js"

export type { Context }

export type Cleanup = () => Promise<void> | void

/** The plugin API version this host implements; see README.md for what each version adds. */
export const API = 1

export interface Definition {
  readonly id: string
  /** The plugin API version the plugin was written against. Setup fails when it is newer than the host. */
  readonly api?: number
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

export function define(plugin: Definition) {
  return plugin
}
