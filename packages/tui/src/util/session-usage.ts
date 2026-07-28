import type { AssistantMessage, Message, Provider } from "@opencode-ai/sdk/v2"
import { Locale } from "./locale"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export type SessionUsage = {
  context: string
  percent?: string
  cache?: string
  cost?: string
}

export function sessionUsage(input: {
  messages: Message[]
  providers: Provider[]
  cost: number
}): SessionUsage | undefined {
  const last = input.messages.findLast(
    (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
  )
  if (!last) return undefined

  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return undefined

  const model = input.providers.find((item) => item.id === last.providerID)?.models[last.modelID]
  const percent = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined

  let cumulativeInput = 0
  let cumulativeCacheRead = 0
  let cumulativeCacheWrite = 0
  for (const item of input.messages) {
    if (item.role !== "assistant" || item.tokens.output === 0) continue
    cumulativeInput += item.tokens.input
    cumulativeCacheRead += item.tokens.cache.read
    cumulativeCacheWrite += item.tokens.cache.write
  }
  const cacheDenominator = cumulativeInput + cumulativeCacheRead + cumulativeCacheWrite
  const cacheHitRatio =
    cumulativeCacheRead + cumulativeCacheWrite > 0 && cacheDenominator > 0
      ? Math.round((cumulativeCacheRead / cacheDenominator) * 100)
      : undefined

  return {
    context: percent ? `${Locale.number(tokens)} (${percent})` : Locale.number(tokens),
    percent,
    cache: cacheHitRatio === undefined ? undefined : `cache ${cacheHitRatio}%`,
    cost: input.cost > 0 ? money.format(input.cost) : undefined,
  }
}

export function fitSessionUsage(usage: SessionUsage, width: number) {
  const compactContext = usage.percent ?? usage.context
  const candidates = [
    [usage.context, usage.cache, usage.cost],
    [compactContext, usage.cache, usage.cost],
    [compactContext, usage.cache],
    [compactContext],
  ]
    .map((parts) => parts.filter((part): part is string => Boolean(part)).join(" · "))
    .filter((value, index, values) => value && values.indexOf(value) === index)

  return candidates.find((value) => value.length <= width)
}
