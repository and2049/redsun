import { createEffect, createSignal, onCleanup } from "solid-js"
import type { RemoteControl } from "@opencode-ai/schema/remote-control"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"

export function remoteLabel(status?: Pick<RemoteControl.Status, "state">, compact = false) {
  if (!status) return compact ? "RC unknown" : "RC status unknown"
  if (compact)
    return { disabled: "RC off", unavailable: "RC on/unavailable", ready: "RC ready", connected: "RC connected" }[
      status.state
    ]
  return {
    disabled: "RC disabled",
    unavailable: "RC enabled, unavailable",
    ready: "RC ready",
    connected: "RC connected",
  }[status.state]
}

export const { use: useRemoteControl, provider: RemoteControlProvider } = createSimpleContext({
  name: "RemoteControl",
  init: () => {
    const client = useClient()
    const [status, setStatus] = createSignal<RemoteControl.Status>()
    const [error, setError] = createSignal<string>()
    let active = true
    let generation = 0
    const refresh = () =>
      Promise.resolve(++generation).then(async (request) => {
        try {
          const value = await client.api.remote.status()
          if (active && request === generation) setStatus(value)
        } catch {
          if (active && request === generation) setStatus(undefined)
        }
      })
    createEffect(() => {
      if (client.connection.status() !== "connected") {
        setStatus(undefined)
        return
      }
      void refresh()
    })
    const unsubscribe = client.event.on("remote.status", () => void refresh())
    const timer = setInterval(() => void refresh(), 5000)
    onCleanup(() => {
      active = false
      clearInterval(timer)
      unsubscribe()
    })
    const change = async (operation: "enable" | "disable" | "revoke") => {
      setError(undefined)
      try {
        const result =
          operation === "revoke"
            ? await client.api.remote.revoke()
            : await client.api.remote.policy({ enabled: operation === "enable" })
        generation++
        setStatus(result.status)
        if (!result.persisted)
          setError(
            "Restart persistence was NOT updated. Running state is shown above; fix configuration access and retry.",
          )
      } catch {
        setError("Operation was not confirmed. Refresh status and retry; do not assume remote access was disabled.")
        await refresh()
      }
    }
    return { status, error, change, refresh }
  },
})
