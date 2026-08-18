// REDSUN: the session's cost and context readout, sized to fit.
//
// It shares the command bar's idle row with the workspace name, so it has to
// give ground as the terminal narrows rather than wrapping or truncating
// mid-number. `fitSessionUsage` picks the longest form that fits.
import type { SessionMessageInfo, SessionMessageAssistant } from "@opencode-ai/client/promise"
import { Locale } from "./locale"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export type SessionUsage = {
  context: string
  percent?: string
  cache?: string
  cost?: string
}

export function sessionUsage(input: {
  messages: readonly SessionMessageInfo[]
  contextLimit?: (model: { providerID: string; id: string }) => number | undefined
  cost: number
}): SessionUsage | undefined {
  const last = input.messages.findLast(
    (item): item is SessionMessageAssistant => item.type === "assistant" && (item.tokens?.output ?? 0) > 0,
  )
  if (!last?.tokens) return undefined

  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return undefined

  const limit = input.contextLimit?.(last.model)
  const percent = limit ? `${Math.round((tokens / limit) * 100)}%` : undefined

  // Cache hit ratio is cumulative across the session, not just this turn: a
  // single turn's ratio swings too hard to read at a glance.
  let cumulativeInput = 0
  let cumulativeRead = 0
  let cumulativeWrite = 0
  for (const item of input.messages) {
    if (item.type !== "assistant" || !item.tokens || item.tokens.output === 0) continue
    cumulativeInput += item.tokens.input
    cumulativeRead += item.tokens.cache.read
    cumulativeWrite += item.tokens.cache.write
  }
  const denominator = cumulativeInput + cumulativeRead + cumulativeWrite
  const ratio =
    cumulativeRead + cumulativeWrite > 0 && denominator > 0
      ? Math.round((cumulativeRead / denominator) * 100)
      : undefined

  return {
    context: percent ? `${Locale.number(tokens)} (${percent})` : Locale.number(tokens),
    percent,
    cache: ratio === undefined ? undefined : `cache ${ratio}%`,
    cost: input.cost > 0 ? money.format(input.cost) : undefined,
  }
}

/** The longest form of the readout that fits in `width`, or nothing. */
export function fitSessionUsage(usage: SessionUsage, width: number) {
  const compact = usage.percent ?? usage.context
  return [
    [usage.context, usage.cache, usage.cost],
    [compact, usage.cache, usage.cost],
    [compact, usage.cache],
    [compact],
  ]
    .map((parts) => parts.filter((part): part is string => Boolean(part)).join(" · "))
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .find((value) => value.length <= width)
}
