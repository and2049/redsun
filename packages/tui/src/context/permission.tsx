import { createEffect, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "normal"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const client = useClient()
    const [store, setStore] = createStore<{ mode: PermissionMode }>({ mode: args.auto ? "auto" : "normal" })
    const [hydrated, setHydrated] = createSignal(false)

    const push = (mode: PermissionMode) =>
      client.api.permission.mode
        .set({ mode })
        .catch((error) => console.error("Failed to set permission mode", error))

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
              setStore("mode", result.mode === "auto" ? "auto" : "normal")
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
      toggle() {
        set(store.mode === "auto" ? "normal" : "auto")
      },
    }
  },
})
