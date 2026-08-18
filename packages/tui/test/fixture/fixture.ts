import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { ThemeSource } from "../../src/context/theme"
import type { ThemeV1Json } from "../../src/theme"
import themeV1 from "./theme-v1.json" with { type: "json" }

export const emptyThemeSource: ThemeSource = { discover: () => Promise.resolve({}) }

/**
 * A complete v1 theme document, for tests that exercise the v1 path.
 *
 * Redsun ships only native v2 documents, so there is no longer a shipped theme
 * to clone for this. Returns a fresh copy: callers mutate it.
 */
export function v1Theme(): ThemeV1Json {
  return structuredClone(themeV1) as ThemeV1Json
}

export async function tmpdir() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "opencode-tui-test-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}
