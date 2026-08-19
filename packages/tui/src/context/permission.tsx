import { createEffect, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "normal"

// REDSUN: auto-approve is server state, and this is its mirror.
//
// It was a TUI preference, which meant it only answered requests for the
// session on screen -- a background subagent asking from elsewhere waited on a
// dialog nobody was rendering, which reads as a hang. The server now grants
// what would have prompted (see core `permission.ts`), so this holds the value
// only to draw the row and to toggle it. The store is optimistic so shift+tab
// stays instant; the request behind it reconciles.
//
// `--auto` still forces the mode for one run, but now it forces it on the
// server too -- there is nowhere else for it to take effect.
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

    // Hydrate on every (re)connect: a restarted service is a fresh read, and
    // `--auto` has to be re-asserted against it.
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
      /** False until the server's value has been read at least once. */
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
