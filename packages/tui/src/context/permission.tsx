import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { LocationRef } from "@opencode/client"
import { useArgs } from "./args"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "normal" | "native_auto"

/** `native` is whether the model's delegated runtime has its own auto-approval mode. */
export function effectivePermissionMode(mode: PermissionMode, native: boolean): PermissionMode {
  return mode === "native_auto" && !native ? "normal" : mode
}

export function nextPermissionMode(mode: PermissionMode, native: boolean): PermissionMode {
  const effective = effectivePermissionMode(mode, native)
  if (!native) return effective === "auto" ? "normal" : "auto"
  return effective === "normal" ? "native_auto" : effective === "native_auto" ? "auto" : "normal"
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const client = useClient()
    const [store, setStore] = createStore<{ mode: PermissionMode }>({ mode: "normal" })
    const [hydrated, setHydrated] = createSignal(false)
    type ModelRef = { readonly providerID: string; readonly modelID: string }
    // Per location/model: behavior profiles and runtime capabilities are location-scoped.
    // Unknown models are fetched once, lazily;
    // the cache is dropped on every (re)connect, since runtimes register with the server.
    const [native, setNative] = createStore<Record<string, boolean>>({})
    const pending = new Map<string, Promise<boolean>>()
    const nativeKey = (model: ModelRef, location?: LocationRef) =>
      JSON.stringify([location?.directory, model.providerID, model.modelID])
    const lookup = (model: ModelRef, location?: LocationRef) => {
      const key = nativeKey(model, location)
      const known = native[key]
      if (known !== undefined) return Promise.resolve(known)
      const inflight = pending.get(key)
      if (inflight) return inflight
      const request = client.api.permission.mode
        .options({ location, providerID: model.providerID, modelID: model.modelID })
        .then((result) => result.native)
        // An answer the server cannot give (an older server, a dropped connection) is "no" until
        // the next connect, rather than a request on every render.
        .catch(() => false)
        .then((value) => {
          setNative(key, value)
          return value
        })
        .finally(() => pending.delete(key))
      pending.set(key, request)
      return request
    }
    /** The answer so far: false while the lookup is still out. */
    const nativeFor = (model?: ModelRef, location?: LocationRef) => {
      if (!model) return false
      const key = nativeKey(model, location)
      const known = native[key]
      if (known === undefined) void lookup(model, location)
      return known === true
    }
    /** The answer once it is known. */
    const resolveNative = (model?: ModelRef, location?: LocationRef) =>
      model ? lookup(model, location) : Promise.resolve(false)

    let revision = 0
    let connection = 0
    let launchAuto = !!args.auto
    let writes = Promise.resolve()
    onCleanup(
      client.event.on("permission.mode.changed", (event) => {
        revision++
        setStore("mode", event.data.mode)
        setHydrated(true)
      }),
    )

    const refresh = async () => {
      const before = revision
      const epoch = connection
      try {
        const result = await client.api.permission.mode.get()
        if (before !== revision || epoch !== connection) return
        revision++
        setStore("mode", result.mode)
        setHydrated(true)
      } catch (error) {
        console.error("Failed to read permission mode", error)
      }
    }
    const write = async (mode: PermissionMode) => {
      const before = revision
      const epoch = connection
      try {
        await client.api.permission.mode.set({ mode })
        // The event is authoritative. This fallback also supports an older server.
        if (before === revision && epoch === connection) {
          revision++
          setStore("mode", mode)
          setHydrated(true)
        }
      } catch (error) {
        // Never display an unconfirmed auto-approval selection. The write might have
        // reached the server before the response failed, so reconcile with a snapshot.
        console.error("Failed to set permission mode", error)
        await refresh()
      }
    }
    const enqueue = (selection: () => Promise<PermissionMode> | PermissionMode) => {
      writes = writes.then(async () => write(await selection()))
      return writes
    }
    const set = (mode: PermissionMode) => enqueue(() => mode)

    createEffect(
      on(
        () => client.connection.status(),
        (status) => {
          connection++
          if (status !== "connected") return
          setNative(reconcile({}))
          if (launchAuto) {
            launchAuto = false
            void set("auto")
            return
          }
          void refresh()
        },
      ),
    )

    return {
      get mode() {
        return store.mode
      },
      get hydrated() {
        return hydrated()
      },
      set,
      nativeFor,
      resolveNative,
      /** Cycles the mode for a model, once its runtime's options are known (a press can beat the lookup). */
      toggle(model?: ModelRef, location?: LocationRef) {
        return enqueue(async () => {
          const native = await resolveNative(model, location)
          return nextPermissionMode(store.mode, native)
        })
      },
    }
  },
})
