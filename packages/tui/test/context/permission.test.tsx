/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { onMount } from "solid-js"
import { Flock } from "@opencode-ai/core/util/flock"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider, usePermission } from "../../src/context/permission"
import { TestTuiContexts } from "../fixture/tui-environment"

Flock.setGlobal({ state: mkdtempSync(join(tmpdir(), "redsun-flock-")) })

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mount(state: string) {
  let permission!: ReturnType<typeof usePermission>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    permission = usePermission()
    onMount(done)
    return <box />
  }

  await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <ArgsProvider>
        <KVProvider>
          <PermissionProvider>
            <Probe />
          </PermissionProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))
  await ready
  return permission
}

function persistedMode(state: string): unknown {
  const file = join(state, "kv.json")
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    if (!("auto_approve_mode" in parsed)) return undefined
    return parsed.auto_approve_mode
  } catch {
    return undefined
  }
}

test("persists the auto-approve mode across instances", async () => {
  const state = mkdtempSync(join(tmpdir(), "redsun-permission-"))
  try {
    const first = await mount(state)
    expect(first.mode).toBe("normal")

    first.toggle()
    expect(first.mode).toBe("auto")
    await wait(() => persistedMode(state) === "auto")

    const second = await mount(state)
    expect(second.mode).toBe("auto")

    second.toggle()
    expect(second.mode).toBe("normal")
    await wait(() => persistedMode(state) === "normal")

    const third = await mount(state)
    expect(third.mode).toBe("normal")
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
