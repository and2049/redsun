import { createEffect, createSignal, on } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
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
    const [store, setStore] = createStore<{ mode: PermissionMode }>({ mode: args.auto ? "auto" : "normal" })
    const [hydrated, setHydrated] = createSignal(false)
    type ModelRef = { readonly providerID: string; readonly modelID: string }
    // Per model: whether its runtime offers native_auto. Unknown models are fetched once, lazily;
    // the cache is dropped on every (re)connect, since runtimes register with the server.
    const [native, setNative] = createStore<Record<string, boolean>>({})
    const pending = new Map<string, Promise<boolean>>()
    const lookup = (model: ModelRef) => {
      const key = `${model.providerID}/${model.modelID}`
      const known = native[key]
      if (known !== undefined) return Promise.resolve(known)
      const inflight = pending.get(key)
      if (inflight) return inflight
      const request = client.api.permission.mode
        .options({ providerID: model.providerID, modelID: model.modelID })
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
    const nativeFor = (model?: ModelRef) => {
      if (!model) return false
      const key = `${model.providerID}/${model.modelID}`
      const known = native[key]
      if (known === undefined) void lookup(model)
      return known === true
    }
    /** The answer once it is known. */
    const resolveNative = (model?: ModelRef) => (model ? lookup(model) : Promise.resolve(false))

    const push = (mode: PermissionMode) =>
      client.api.permission.mode.set({ mode }).catch((error) => console.error("Failed to set permission mode", error))

    createEffect(
      on(
        () => client.connection.status(),
        (status) => {
          if (status !== "connected") return
          setNative(reconcile({}))
          if (args.auto) {
            setStore("mode", "auto")
            setHydrated(true)
            void push("auto")
            return
          }
          void client.api.permission.mode
            .get()
            .then((result) => {
              setStore("mode", result.mode === "auto" || result.mode === "native_auto" ? result.mode : "normal")
              setHydrated(true)
            })
            .catch((error) => console.error("Failed to read permission mode", error))
        },
      ),
    )

    const set = (mode: PermissionMode) => {
      if (store.mode === mode) return
      setStore("mode", mode)
      void push(mode)
    }

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
      toggle(model?: ModelRef) {
        return resolveNative(model).then((native) => set(nextPermissionMode(store.mode, native)))
      },
    }
  },
})
