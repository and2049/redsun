import { createEffect, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"
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
    // Per model: whether its runtime offers native_auto. Unknown models are fetched once, lazily.
    const [native, setNative] = createStore<Record<string, boolean>>({})
    const pending = new Set<string>()
    const nativeFor = (model?: { readonly providerID: string; readonly modelID: string }) => {
      if (!model) return false
      const key = `${model.providerID}/${model.modelID}`
      const known = native[key]
      if (known === undefined && !pending.has(key)) {
        pending.add(key)
        void client.api.permission.mode
          .options({ providerID: model.providerID, modelID: model.modelID })
          .then((result) => setNative(key, result.native))
          .catch(() => {})
          .finally(() => pending.delete(key))
      }
      return known === true
    }

    const push = (mode: PermissionMode) =>
      client.api.permission.mode.set({ mode }).catch((error) => console.error("Failed to set permission mode", error))

    createEffect(
      on(
        () => client.connection.status(),
        (status) => {
          if (status !== "connected") return
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
      toggle(native: boolean) {
        set(nextPermissionMode(store.mode, native))
      },
    }
  },
})
