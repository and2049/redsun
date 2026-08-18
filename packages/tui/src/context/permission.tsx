import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"
import { useStorage } from "./storage"

export type PermissionMode = "auto" | "normal"

// REDSUN: auto-approve is a preference, not a per-run choice. Someone who works
// with it on wants it on tomorrow too, and having to re-arm it every launch is
// the kind of friction that trains people to stop noticing the row that reports
// it. `--auto` still forces the mode for one run without rewriting the
// preference; only an explicit toggle does that.
const STORAGE_KEY = "permission"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    // Storage reads its file when the entry is created, so this is the stored
    // value rather than the initial default.
    const [persisted, persist] = useStorage().store<{ mode: PermissionMode }>(STORAGE_KEY, {
      initial: { mode: "normal" },
    })
    const [store, setStore] = createStore<{ mode: PermissionMode }>({
      mode: args.auto || persisted.mode === "auto" ? "auto" : "normal",
    })
    const remember = (mode: PermissionMode) => {
      void persist((draft) => {
        draft.mode = mode
      }).catch((error) => console.error("Failed to persist permission mode", error))
    }
    return {
      get mode() {
        return store.mode
      },
      set(mode: PermissionMode) {
        setStore("mode", mode)
        remember(mode)
      },
      toggle() {
        const next = store.mode === "auto" ? "normal" : "auto"
        setStore("mode", next)
        remember(next)
      },
    }
  },
})
