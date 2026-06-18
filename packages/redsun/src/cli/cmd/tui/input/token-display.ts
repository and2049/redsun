import type { AssistantMessage } from "@redsun/sdk/v2"

type TokenUsage = AssistantMessage["tokens"]

export function formatCompactNumber(num: number) {
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, "") + "K"
  }
  return num.toLocaleString()
}

export function formatCacheHitRatio(tokens: TokenUsage): string | undefined {
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  if (cacheRead === 0 && cacheWrite === 0) return

  const denominator = tokens.input + cacheRead
  if (denominator <= 0) return "cache 0%"
  return `cache ${Math.round((cacheRead / denominator) * 100)}%`
}

export function formatContextStatus(input: { tokens: TokenUsage; contextLimit?: number }) {
  const tokens = input.tokens
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const parts = [formatCompactNumber(total)]

  if (input.contextLimit) {
    parts[0] += " (" + Math.round((total / input.contextLimit) * 100) + "%)"
  }

  const cache = formatCacheHitRatio(tokens)
  if (cache) parts.push(cache)
  return parts.join(" · ")
}
