import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { APICallError } from "ai"
import { NamedError } from "@redsun/util/error"

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps retry hints to the maximum setTimeout delay", () => {
    const error = apiError({ "retry-after-ms": String(Number.MAX_SAFE_INTEGER) })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })
})

describe("session.message-v2.fromError", () => {
  test("classifies Z.AI request overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "tokens in request more than max tokens allowed",
        url: "https://api.z.ai/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
      }),
      { providerID: "zai" },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("allows one compaction retry for request overflow", () => {
    const error = new MessageV2.ContextOverflowError({ message: "too long" }).toObject()
    expect(SessionPrompt.shouldRetryContextOverflow(error, [])).toBe(true)
    expect(SessionPrompt.shouldRetryContextOverflow(error, [], false)).toBe(false)
    expect(
      SessionPrompt.shouldRetryContextOverflow(error, [
        {
          info: { id: "m1", sessionID: "s1", role: "user", agent: "build", time: { created: 1 } },
          parts: [
            { id: "p1", messageID: "m1", sessionID: "s1", type: "compaction", auto: true, overflow: true },
          ],
        } as MessageV2.WithParts,
      ]),
    ).toBe(false)
  })

  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await Bun.sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID: "test" })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("retries provider 5xx errors even when the SDK does not", () => {
    const error = new MessageV2.APIError({
      message: "Service unavailable",
      statusCode: 503,
      isRetryable: false,
    }).toObject() as MessageV2.APIError
    expect(SessionRetry.retryable(error)).toBe("Service unavailable")
  })

  test("does not retry non-retryable 4xx errors", () => {
    const error = new MessageV2.APIError({
      message: "Bad request",
      statusCode: 400,
      isRetryable: false,
    }).toObject() as MessageV2.APIError
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries plain-text provider rate limits", () => {
    const error = new NamedError.Unknown({ message: "Alibaba request rate increased too quickly" }).toObject()
    expect(SessionRetry.retryable(error)).toBe("Alibaba request rate increased too quickly")
  })

  test("does not throw on numeric or missing JSON codes", () => {
    for (const message of ['{"error":{"code":123}}', '{"error":{"message":"bad request"}}']) {
      const error = new NamedError.Unknown({ message }).toObject()
      expect(SessionRetry.retryable(error)).toBeUndefined()
    }
  })

  test("marks OpenAI 404 responses as retryable and keeps the request URL", () => {
    const error = new APICallError({
      message: "Not Found",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 404,
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: "openai" }) as MessageV2.APIError
    expect(result.data.isRetryable).toBe(true)
    expect(result.data.metadata?.url).toBe("https://api.openai.com/v1/responses")
  })

  test("classifies decompression failures unless the request was aborted", () => {
    const error = Object.assign(new Error("decompression failed"), { code: "ZlibError" })
    const retry = MessageV2.fromError(error, { providerID: "openai" })
    const aborted = MessageV2.fromError(error, { providerID: "openai", aborted: true })
    expect(MessageV2.APIError.isInstance(retry)).toBe(true)
    expect((retry as MessageV2.APIError).data.isRetryable).toBe(true)
    expect(MessageV2.AbortedError.isInstance(aborted)).toBe(true)
  })

  test("classifies Responses API mid-stream errors", () => {
    const overflow = MessageV2.fromError(
      { type: "error", error: { code: "context_length_exceeded" } },
      { providerID: "openai" },
    )
    const quota = MessageV2.fromError(
      { type: "error", error: { code: "insufficient_quota" } },
      { providerID: "openai" },
    )
    expect(MessageV2.ContextOverflowError.isInstance(overflow)).toBe(true)
    expect(MessageV2.APIError.isInstance(quota)).toBe(true)
    expect((quota as MessageV2.APIError).data.isRetryable).toBe(false)
  })
})
