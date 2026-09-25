import { expect, test } from "bun:test"
import { parseOpenAIUsage } from "../../src/plugin/provider/openai-usage"

const weekly = { used_percent: 21, limit_window_seconds: 604800, reset_at: 1790762400 }
const short = { used_percent: 51, limit_window_seconds: 18000, reset_at: 1790294400 }

test("weekly-only Pro produces one weekly bar, even in the primary slot", () => {
  const usage = parseOpenAIUsage({ plan_type: "pro", rate_limit: { primary_window: weekly, secondary_window: null } })
  expect(usage.windows).toEqual([
    { id: "primary", label: "Weekly", usedPercent: 21, reset: new Date(weekly.reset_at * 1000).toISOString() },
  ])
})

test("Plus uses both reported windows and does not synthesize missing limits", () => {
  const usage = parseOpenAIUsage({ plan_type: "plus", rate_limit: { primary_window: short, secondary_window: weekly } })
  expect(usage.windows.map((window) => [window.label, window.usedPercent])).toEqual([
    ["5-hour", 51],
    ["Weekly", 21],
  ])
  expect(parseOpenAIUsage({ rate_limit: null }).windows).toEqual([])
  expect(() => parseOpenAIUsage({ rate_limit: { primary_window: { ...short, used_percent: -1 } } })).toThrow()
})
