import { Flag } from "../flag/flag"

declare global {
  const REDSUN_VERSION: string
  const REDSUN_CHANNEL: string
}

export namespace Installation {
  export const VERSION = typeof REDSUN_VERSION === "string" ? REDSUN_VERSION : "local"
  export const CHANNEL = typeof REDSUN_CHANNEL === "string" ? REDSUN_CHANNEL : "local"
  export const USER_AGENT = `redsun/${CHANNEL}/${VERSION}/${Flag.REDSUN_CLIENT}`

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }
}
