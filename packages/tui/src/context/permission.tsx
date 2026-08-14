import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"

export type PermissionMode = "auto" | "normal"

// The KVProvider only renders children once kv.ready, so reads here are safe.
const STORAGE_KEY = "auto_approve_mode"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const kv = useKV()
    const persisted = kv.get(STORAGE_KEY)
    const [store, setStore] = createStore<{ mode: PermissionMode }>({
      mode: persisted === "auto" || persisted === "normal" ? persisted : "normal",
    })
    return {
      get mode() {
        return store.mode
      },
      set(mode: PermissionMode) {
        setStore("mode", mode)
        kv.set(STORAGE_KEY, mode)
      },
      toggle() {
        const next = store.mode === "auto" ? "normal" : "auto"
        setStore("mode", next)
        kv.set(STORAGE_KEY, next)
      },
    }
  },
})
