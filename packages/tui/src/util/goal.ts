/**
 * REDSUN: /goal argument grammar. Leading flags set a per-goal budget; the first
 * non-flag token starts the condition, which is kept verbatim (it may contain `--`).
 *
 *   /goal --tokens 200k --time 30m all tests pass
 *
 * `--tokens <n>[k|m]` — decimals allowed only with a suffix; bare values are raw counts.
 * `--time <n>(s|m|h)` — unit required; `0s` is legal and immediately exhausts the budget.
 * Both accept `--flag=value`. Repeated or unknown flags and malformed values are errors.
 */

export interface GoalBudget {
  tokens?: number
  wallClockMs?: number
}

export interface ParsedGoalArgs {
  condition: string
  budget?: GoalBudget
  error?: string
}

const TOKENS_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
const TIME_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h)$/i
const TIME_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 }

const failure = (error: string): ParsedGoalArgs => ({ condition: "", error })

export const parseGoalArgs = (input: string): ParsedGoalArgs => {
  const trimmed = input.trim()
  const budget: GoalBudget = {}
  let index = 0
  while (index < trimmed.length) {
    const rest = trimmed.slice(index)
    const whitespace = rest.match(/^\s+/)
    if (whitespace) {
      index += whitespace[0].length
      continue
    }
    if (!rest.startsWith("--")) break
    const token = rest.match(/^\S+/)![0]
    index += token.length
    const equals = token.indexOf("=")
    const name = equals >= 0 ? token.slice(0, equals) : token
    let value = equals >= 0 ? token.slice(equals + 1) : undefined
    if (value === undefined) {
      const following = trimmed.slice(index).match(/^\s+(\S+)/)
      if (following) {
        value = following[1]
        index += following[0].length
      }
    }
    if (name === "--tokens") {
      if (budget.tokens !== undefined) return failure("duplicate flag: --tokens")
      if (!value) return failure("missing value for --tokens (e.g. --tokens 200k)")
      const match = TOKENS_PATTERN.exec(value)
      if (!match) return failure(`invalid --tokens value: ${value}`)
      const amount = Number.parseFloat(match[1]!)
      const suffix = match[2]?.toLowerCase()
      if (suffix === undefined && !Number.isInteger(amount)) return failure(`invalid --tokens value: ${value}`)
      budget.tokens = Math.round(amount * (suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1))
    } else if (name === "--time") {
      if (budget.wallClockMs !== undefined) return failure("duplicate flag: --time")
      if (!value) return failure("missing value for --time (e.g. --time 30m)")
      const match = TIME_PATTERN.exec(value)
      if (!match) return failure(`invalid --time value: ${value} (unit s, m, or h required)`)
      budget.wallClockMs = Math.round(Number.parseFloat(match[1]!) * TIME_MS[match[2]!.toLowerCase()]!)
    } else {
      return failure(`unknown flag: ${name}`)
    }
  }
  const condition = trimmed.slice(index).trim()
  return {
    condition,
    ...(budget.tokens !== undefined || budget.wallClockMs !== undefined ? { budget } : {}),
  }
}

const formatTokens = (tokens: number) => {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}m`
  if (tokens >= 1_000 && tokens % 100 === 0) return `${tokens / 1_000}k`
  return String(tokens)
}

const formatTime = (ms: number) => {
  if (ms >= 3_600_000 && ms % 360_000 === 0) return `${ms / 3_600_000}h`
  if (ms >= 60_000 && ms % 6_000 === 0) return `${ms / 60_000}m`
  return `${ms / 1_000}s`
}

/** Short human form for toasts and the goal chip: "200k tokens · 30m". */
export const formatGoalBudget = (budget: GoalBudget): string =>
  [
    ...(budget.tokens !== undefined ? [`${formatTokens(budget.tokens)} tokens`] : []),
    ...(budget.wallClockMs !== undefined ? [formatTime(budget.wallClockMs)] : []),
  ].join(" · ")
