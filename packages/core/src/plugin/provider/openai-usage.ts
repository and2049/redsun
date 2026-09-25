import type { Credential } from "@opencode/schema/credential"
import type { Usage } from "@opencode/plugin/usage"
import { z } from "zod"

const Window = z.object({
  used_percent: z.number().finite().nonnegative(),
  limit_window_seconds: z.number().finite().positive(),
  reset_at: z.number().finite().nonnegative().optional(),
})
const Payload = z.object({
  plan_type: z.string().optional(),
  rate_limit: z
    .object({
      primary_window: Window.nullish(),
      secondary_window: Window.nullish(),
    })
    .nullish(),
})

export function parseOpenAIUsage(value: unknown): Usage.Data {
  const payload = Payload.parse(value)
  const windows = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window].flatMap(
    (window, index): Usage.Window[] => {
      if (!window) return []
      const seconds = window.limit_window_seconds
      const label = seconds === 604_800 ? "Weekly" : seconds === 18_000 ? "5-hour" : `${seconds / 3600}-hour`
      return [
        {
          id: index === 0 ? "primary" : "secondary",
          label,
          usedPercent: window.used_percent,
          ...(window.reset_at === undefined ? {} : { reset: new Date(window.reset_at * 1000).toISOString() }),
        },
      ]
    },
  )
  return {
    windows,
    plan: payload.plan_type,
    ...(windows.length ? {} : { message: "This account did not report any usage limits." }),
  }
}

export async function readOpenAIUsage(credential: Credential.OAuth, signal: AbortSignal): Promise<Usage.Data> {
  const accountID = credential.metadata?.accountID
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    signal,
    redirect: "error",
    headers: {
      authorization: `Bearer ${credential.access}`,
      ...(typeof accountID === "string" ? { "ChatGPT-Account-Id": accountID } : {}),
    },
  })
  if (!response.ok) throw new Error(`Usage request failed (${response.status})`)
  return parseOpenAIUsage(await response.json())
}
