import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

test.each([
  { args: ["--help"], code: 0 },
  { args: ["serve", "--port", "not-a-port"], code: 1 },
  { args: ["unknown", "--helpful"], code: 1 },
])(
  "remote companion forwards $args without a stack trace",
  async ({ args, code }) => {
    await using temporary = await tmpdir()
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("../src/index.ts", import.meta.url)), "remote", "companion", ...args],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...isolatedEnv(temporary.path), LOCALAPPDATA: temporary.path, XDG_DATA_HOME: temporary.path },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).toBe(code)
    if (code === 0) expect(stdout.startsWith("Usage: redsun remote companion")).toBe(true)
    expect(stdout + stderr).not.toMatch(/\n\s+at |Error:|cli process failed/)
  },
  15_000,
)
