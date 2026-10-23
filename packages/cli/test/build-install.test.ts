import { expect, test } from "bun:test"

test("cross-compilation installs native dependencies for every OS, CPU, and libc", async () => {
  const build = await Bun.file(new URL("../script/build.ts", import.meta.url)).text()
  const install = build.match(/bun install[^\n]+/)?.[0]
  expect(install).toBeDefined()
  for (const flag of ["os", "cpu", "libc"]) {
    expect(install).toContain(`--${flag}="*"`)
  }
})
