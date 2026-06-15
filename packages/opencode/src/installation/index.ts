import { Flag } from "../flag/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export namespace Installation {
  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `redsun/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }
}
