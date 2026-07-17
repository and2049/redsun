import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { FileIgnore } from "./ignore"
import { Config } from "../config/config"
import path from "path"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import { lazy } from "@/util/lazy"
import type ParcelWatcher from "@parcel/watcher"
import { $ } from "bun"
import { Flag } from "@/flag/flag"
import { readdir, realpath } from "fs/promises"
import { withTimeout } from "../util/timeout"
import { Protected } from "./protected"

declare const REDSUN_LIBC: string | undefined
const SUBSCRIBE_TIMEOUT_MS = 10_000

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const binding = require(
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${REDSUN_LIBC || "glibc"}` : ""}`,
      )
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return undefined
    }
  })

  export async function resolveGitDirectory(worktree: string) {
    const result = await $`git rev-parse --git-dir`.quiet().nothrow().cwd(worktree)
    if (result.exitCode !== 0) return
    const value = result.text().trim()
    if (!value) return
    const resolved = path.resolve(worktree, value)
    return realpath(resolved).catch(() => resolved)
  }

  const state = Instance.state(
    async () => {
      log.info("init")
      const cfg = await Config.get()
      const backend = (() => {
        if (process.platform === "win32") return "windows"
        if (process.platform === "darwin") return "fs-events"
        if (process.platform === "linux") return "inotify"
      })()
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return {}
      }
      log.info("watcher backend", { platform: process.platform, backend })
      const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        for (const evt of evts) {
          if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
          if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
          if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
        }
      }

      const subs: ParcelWatcher.AsyncSubscription[] = []
      const cfgIgnores = cfg.watcher?.ignore ?? []
      const w = watcher()
      if (!w) return {}

      if (Flag.REDSUN_EXPERIMENTAL_FILEWATCHER) {
        const pending = w.subscribe(Instance.directory, subscribe, {
          ignore: [...FileIgnore.PATTERNS, ...cfgIgnores, ...Protected.paths()],
          backend,
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((error) => {
          log.error("failed to subscribe to project directory", { error })
          pending.then((value) => value.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      const vcsDir = Instance.project.vcs === "git" ? await resolveGitDirectory(Instance.worktree) : undefined
      if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
        const ignore = (await readdir(vcsDir).catch(() => [])).filter((entry) => entry !== "HEAD")
        const pending = w.subscribe(vcsDir, subscribe, { ignore, backend })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((error) => {
          log.error("failed to subscribe to git directory", { error })
          pending.then((value) => value.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      return { subs }
    },
    async (state) => {
      if (!state.subs) return
      await Promise.all(state.subs.map((sub) => sub?.unsubscribe()))
    },
  )

  export function init() {
    if (Flag.REDSUN_EXPERIMENTAL_DISABLE_FILEWATCHER) {
      return
    }
    state()
  }
}
