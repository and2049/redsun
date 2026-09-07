import { createEffect, createSignal, onCleanup } from "solid-js"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { createPrivateFile } from "@opencode-ai/util/private-file"
import type { RemoteControl } from "@opencode-ai/schema/remote-control"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"

export function remoteLabel(status?: Pick<RemoteControl.Status, "state">) {
  if (!status) return "RC status unknown"
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
    const enroll = async (target: string) => {
      setError(undefined)
      const backendID = status()?.backendID
      if (!status()?.supported || !backendID || !client.registration) {
        setError(
          "Enrollment requires a local managed service with a persisted backend identity. Use redsun remote enroll --handoff <new-private-file> locally.",
        )
        return undefined
      }
      let file: string
      let credentialID: string
      let token: string
      try {
        file = path.resolve(target)
        credentialID = randomBytes(16).toString("hex")
        token = randomBytes(32).toString("base64url")
        const handoff: RemoteControl.Handoff = {
          version: 1,
          backendID,
          registration: client.registration,
          credentialID,
          token,
        }
        await createPrivateFile(file, JSON.stringify(handoff, null, 2) + "\n")
      } catch {
        setError("Handoff file could not be created; no credential was issued. Choose a new path.")
        return undefined
      }
      try {
        await client.api.remote.enroll({
          backendID,
          credentialID,
          digest: createHash("sha256").update(token).digest("hex"),
        })
      } catch {
        setError(
          "Enrollment not confirmed; keep the private handoff for reconciliation or revoke credentials before removing it.",
        )
        await refresh()
        return undefined
      }
      await refresh()
      return file
    }
    return { status, error, change, refresh, enroll }
  },
})
