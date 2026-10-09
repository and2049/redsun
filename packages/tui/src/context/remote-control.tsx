import { createEffect, createSignal, onCleanup } from "solid-js"
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
    const [tunnelState, setTunnelState] = createSignal<RemoteControl.Tunnel>()
    const [computersState, setComputersState] = createSignal<RemoteControl.Computers>()
    const [phoneRegistered, setPhoneRegistered] = createSignal(false)
    // True once the companion, tunnel and computers states of the current subscription have all answered (or failed),
    // so a dialog does not offer rows for a state it has not seen yet.
    const [loaded, setLoaded] = createSignal(false)
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
    let tunnelGeneration = 0
    const refreshTunnel = async () => {
      const request = ++tunnelGeneration
      try {
        const value = await client.api.remote.tunnel.get()
        if (active && request === tunnelGeneration) setTunnelState(value)
      } catch {
        if (active && request === tunnelGeneration) setTunnelState(undefined)
      }
    }
    let computersGeneration = 0
    const refreshComputers = async () => {
      const request = ++computersGeneration
      try {
        const value = await client.api.remote.computers.get()
        if (active && request === computersGeneration) setComputersState(value)
      } catch {
        if (active && request === computersGeneration) setComputersState(undefined)
      }
    }
    const subscribe = () => {
      subscribers++
      setLoaded(false)
      void Promise.all([refreshCompanion(), refreshTunnel(), refreshComputers()]).then(() => {
        if (active) setLoaded(true)
      })
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
      if (subscribers === 0) return
      void refreshCompanion()
      void refreshTunnel()
      void refreshComputers()
    }, 2000)
    onCleanup(() => {
      active = false
      clearInterval(timer)
      clearInterval(companionTimer)
      unsubscribe()
    })
    // Turning phone access on is `enableAccess`; this is the way off, and the way to start over.
    const change = async (operation: "disable" | "revoke") => {
      setError(undefined)
      try {
        const result =
          operation === "revoke" ? await client.api.remote.revoke() : await client.api.remote.policy({ enabled: false })
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
        const previous = companion()?.origin
        const result = await client.api.remote.companion.configure(config)
        setCompanion(result)
        // The phone's passkey is bound to the origin; a new origin means registering again.
        if (previous !== undefined && result.origin !== previous) setPhoneRegistered(false)
        await refreshTunnel()
        return result
      })
    const configureTunnel = (config: RemoteControl.TunnelConfig) =>
      action(async () => {
        const previous = tunnelState()?.origin
        const result = await client.api.remote.tunnel.configure(config)
        tunnelGeneration++
        setTunnelState(result)
        if (previous !== undefined && result.origin !== previous) setPhoneRegistered(false)
        return result
      })
    const configureComputers = (config: RemoteControl.ComputersConfig) =>
      action(async () => {
        const result = await client.api.remote.computers.configure(config)
        computersGeneration++
        setComputersState(result)
        return result
      })
    // One call turns phone access on: the backend enrolls a companion when none is, creates the address, enables.
    const enableAccess = () =>
      action(async () => {
        const result = await client.api.remote.enable()
        generation++
        tunnelGeneration++
        setStatus(result.status)
        setTunnelState(result.tunnel)
        setCompanion(result.companion)
        return result
      })
    const pair = () => action(() => client.api.remote.computers.pairing())
    return {
      status,
      error,
      change,
      companion,
      phoneRegistered,
      subscribe,
      configure,
      tunnelState,
      configureTunnel,
      computersState,
      loaded,
      configureComputers,
      enableAccess,
      pair,
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
