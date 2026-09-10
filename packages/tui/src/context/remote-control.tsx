import { createEffect, createSignal, onCleanup } from "solid-js"
import { createHash, randomBytes } from "node:crypto"
import { Effect } from "effect"
import { importHandoff } from "redsun-remote-control"
import type { RemoteControl } from "@opencode/schema/remote-control"
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
    const [companion, setCompanion] = createSignal<RemoteControl.Companion>()
    const [tailscaleState, setTailscaleState] = createSignal<RemoteControl.Tailscale>()
    const [phoneRegistered, setPhoneRegistered] = createSignal(false)
    createEffect(() => {
      if (status()?.state === "connected") setPhoneRegistered(true)
    })
    let subscribers = 0
    let companionGeneration = 0
    const refreshCompanion = async () => {
      const request = ++companionGeneration
      try {
        const value = await client.api.remote.companion.get()
        if (active && request === companionGeneration) setCompanion(value)
      } catch {
        if (active && request === companionGeneration) setCompanion(undefined)
      }
    }
    const subscribe = () => {
      subscribers++
      void refreshCompanion()
      onCleanup(() => subscribers--)
    }
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
    const companionTimer = setInterval(() => {
      if (subscribers > 0) void refreshCompanion()
    }, 2000)
    onCleanup(() => {
      active = false
      clearInterval(timer)
      clearInterval(companionTimer)
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
        if (operation === "revoke") setPhoneRegistered(false)
        if (!result.persisted)
          setError(
            "Restart persistence was NOT updated. Running state is shown above; fix configuration access and retry.",
          )
      } catch {
        setError("Operation was not confirmed. Refresh status and retry; do not assume remote access was disabled.")
        await refresh()
      }
      await refreshCompanion()
    }
    const action = async <A,>(run: () => Promise<A>) => {
      setError(undefined)
      try {
        return await run()
      } catch (failure) {
        const message =
          typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string"
            ? failure.message
            : "Companion operation failed"
        setError(message)
        return undefined
      } finally {
        await refreshCompanion()
      }
    }
    const configure = (config: RemoteControl.CompanionConfig) =>
      action(async () => {
        const result = await client.api.remote.companion.configure(config)
        setCompanion(result)
        setTailscaleState(undefined)
        return result
      })
    const tailscale = () =>
      action(async () => {
        const result = await client.api.remote.tailscale.get()
        setTailscaleState(result)
        return result
      })
    const applyTailscale = () =>
      action(async () => {
        const result = await client.api.remote.tailscale.apply()
        setTailscaleState(result)
        return result
      })
    const enroll = async () => {
      setError(undefined)
      const backendID = status()?.backendID
      if (!status()?.supported || !backendID || !client.registration) {
        setError(
          "Enrollment requires a local managed service with a persisted backend identity. Use redsun remote enroll --handoff <new-private-file> locally.",
        )
        await refreshCompanion()
        return undefined
      }
      let credentialID: string
      let token: string
      try {
        credentialID = randomBytes(16).toString("hex")
        token = randomBytes(32).toString("base64url")
        const handoff: RemoteControl.Handoff = {
          version: 1,
          backendID,
          registration: client.registration,
          credentialID,
          token,
        }
        await Effect.runPromise(importHandoff(handoff))
      } catch {
        setError(
          "A companion is already enrolled on this host or its private store is unavailable; revoke companion credentials and remove the companion store before enrolling again",
        )
        await refreshCompanion()
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
          "Enrollment not confirmed; the companion store holds an unconfirmed credential. Revoke companion credentials, then remove the companion store before retrying",
        )
        await refresh()
        await refreshCompanion()
        return undefined
      }
      await refresh()
      await refreshCompanion()
      setPhoneRegistered(false)
    }
    return {
      status,
      error,
      change,
      refresh,
      refreshCompanion,
      enroll,
      companion,
      phoneRegistered,
      subscribe,
      configure,
      tailscale,
      tailscaleState,
      applyTailscale,
      register: () =>
        action(async () => {
          await client.api.remote.companion.register()
          return true
        }),
      cancelRegistration: () =>
        action(async () => {
          await client.api.remote.companion.cancel()
          return true
        }),
      approve: (requestID: string, fingerprint: string) =>
        action(async () => {
          await client.api.remote.companion.approve({ requestID, fingerprint })
          setPhoneRegistered(true)
          return true
        }),
    }
  },
})
