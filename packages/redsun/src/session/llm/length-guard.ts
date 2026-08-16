import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"

/**
 * REDSUN: buffer complete tool-call parts until the finish part so tool
 * execution cannot start before the finish reason is known (pi parity). When
 * the response was cut off by the output token limit (finishReason "length"),
 * the shared guard flag is set BEFORE the buffered tool calls are flushed, and
 * the tool execute wrappers in session/tools.ts refuse the possibly-truncated
 * calls with an error tool result. Text and tool-input deltas pass through
 * unbuffered, so streaming latency is unaffected.
 */
export function lengthGuardMiddleware(guard: { hit: boolean } | undefined): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3" as const,
    async wrapStream({ doStream }) {
      const result = await doStream()
      if (!guard) return result
      const buffered: LanguageModelV3StreamPart[] = []
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(part, controller) {
            if (part.type === "tool-call") {
              buffered.push(part)
              return
            }
            if (part.type === "finish") {
              if (part.finishReason.unified === "length") guard.hit = true
              for (const item of buffered) controller.enqueue(item)
              buffered.length = 0
            }
            controller.enqueue(part)
          },
          flush(controller) {
            for (const item of buffered) controller.enqueue(item)
          },
        }),
      )
      return { ...result, stream }
    },
  }
}
