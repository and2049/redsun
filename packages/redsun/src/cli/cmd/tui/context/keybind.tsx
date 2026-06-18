import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { Keybind } from "@/util/keybind"
import { pipe, mapValues } from "remeda"
import type { KeybindsConfig } from "@redsun/sdk/v2"
import type { ParsedKey } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { useMode } from "./mode"
import { parseScopedKey, type KeyScope } from "../input/key-scope"
import { getLeaderKeyAction } from "../input/leader"

export const { use: useKeybind, provider: KeybindProvider } = createSimpleContext({
  name: "Keybind",
  init: () => {
    const sync = useSync()
    const keybinds = createMemo(() => {
      return pipe(
        sync.data.config.keybinds ?? {},
        mapValues((value) => Keybind.parse(value)),
      )
    })
    const [store, setStore] = createStore({
      leader: false,
    })
    const vim = useMode()

    useKeyboard(async (evt) => {
      if (vim.mode === "command") return

      if (getLeaderKeyAction(vim.mode, keybinds().leader, evt) === "enter-normal") {
        setStore("leader", false)
        vim.setMode("normal")
        evt.preventDefault()
        return
      }

      if (store.leader && evt.name) {
        setImmediate(() => setStore("leader", false))
      }
    })

    const result = {
      get all() {
        return keybinds()
      },
      get leader() {
        return store.leader
      },
      parse(evt: ParsedKey, scope: KeyScope = "global"): Keybind.Info {
        return parseScopedKey(evt, scope, {
          leader: store.leader,
          vimMode: vim.mode,
        })
      },
      match(key: keyof KeybindsConfig, evt: ParsedKey, scope: KeyScope = "global") {
        const keybind = keybinds()[key]
        if (!keybind) return false
        const parsed = result.parse(evt, scope)
        for (const key of keybind) {
          if (Keybind.match(key, parsed)) {
            return true
          }
        }
      },
      print(key: keyof KeybindsConfig) {
        const first = keybinds()[key]?.at(0)
        if (!first) return ""
        const result = Keybind.toString(first)
        return result.replace("<leader>", Keybind.toString(keybinds().leader![0]!))
      },
    }
    return result
  },
})
