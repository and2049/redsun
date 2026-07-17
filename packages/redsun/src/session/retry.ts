import type { NamedError } from "@redsun/util/error"
import { MessageV2 } from "./message-v2"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647

  function cap(ms: number) {
    return Math.min(ms, RETRY_MAX_DELAY)
  }

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout)
          reject(new DOMException("Aborted", "AbortError"))
        },
        { once: true },
      )
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return cap(parsedMs)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return cap(Math.ceil(parsedSeconds * 1000))
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return cap(Math.ceil(parsed))
          }
        }

        return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
      }
    }

    return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      const status = error.data.statusCode
      if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const message = error.data?.message
    if (typeof message !== "string") return undefined
    const lower = message.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return message
    }

    try {
      const json = JSON.parse(message)
      const code = typeof json?.code === "string" ? json.code : ""
      if (json?.type === "error" && json.error?.type === "too_many_requests") return "Too Many Requests"
      if (code.includes("exhausted") || code.includes("unavailable")) return "Provider is overloaded"
      if (json?.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
        return "Rate Limited"
      }
    } catch {}
    return undefined
  }
}
