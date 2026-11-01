import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { useClient } from "./client"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "normal"

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return mode === "auto" ? "normal" : "auto"
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const client = useClient()
    const [store, setStore] = createStore<{ mode: PermissionMode }>({ mode: "normal" })
    const [hydrated, setHydrated] = createSignal(false)

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
    const enqueue = (selection: () => PermissionMode) => {
      writes = writes.then(() => write(selection()))
      return writes
    }
    const set = (mode: PermissionMode) => enqueue(() => mode)

    createEffect(
      on(
        () => client.connection.status(),
        (status) => {
          connection++
          if (status !== "connected") return
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
      /** Cycles Manual and Auto-approve; writes run in order so a fast double press settles last-wins. */
      toggle() {
        return enqueue(() => nextPermissionMode(store.mode))
      },
    }
  },
})
