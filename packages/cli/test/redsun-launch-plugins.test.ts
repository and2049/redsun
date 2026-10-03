import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Env } from "../src/env"

test("reads the launch client flag ahead of argument parsing", () => {
  expect(Env.client(["--client", "tacocode"])).toBe("tacocode")
  expect(Env.client(["--plugin", "./skin", "--client=tacocode"])).toBe("tacocode")
  expect(Env.client(["--plugin", "./skin"])).toBeUndefined()
})

test("root help documents launch-scoped plugins and the client name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "redsun-launch-plugins-"))
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "--help"], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_TEST_HOME: root,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("--plugin")
    expect(stdout).toContain("--client")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
