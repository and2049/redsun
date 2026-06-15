import { Log } from "../util/log"

// TODO: This is a temporary compatibility shim.
// Plugin hooks are being replaced by the Extension system in Phase 1.
// Each call site should be migrated to use Extension directly in subsequent work.

export namespace Plugin {
  const log = Log.create({ service: "plugin-compat" })

  export type Hooks = any

  export async function init() {
    log.debug("plugin system disabled; use Extension API instead")
  }

  export async function list(): Promise<any[]> {
    return []
  }

  export async function trigger<Name extends string, Input = any, Output = any>(
    _name: Name,
    _input: Input,
    output: Output,
  ): Promise<Output> {
    return output
  }
}
