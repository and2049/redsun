import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { TrustFlag } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

const counters = globalThis as typeof globalThis & Record<string, unknown>

afterEach(() => {
  TrustFlag.clear()
})

async function writeProjectProvider(dir: string, key: string) {
  const module = path.join(dir, `${key}-provider.ts`)
  await Bun.write(
    module,
    `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1
     export const createProvider = () => ({ languageModel: () => ({}) })`,
  )
  await fs.writeFile(
    path.join(dir, "redsun.json"),
    JSON.stringify({
      provider: {
        [key]: {
          npm: pathToFileURL(module).href,
          models: { test: {} },
        },
      },
    }),
  )
}

test("does not import a project provider module before trust", async () => {
  await using tmp = await tmpdir({ git: true, init: (dir) => writeProjectProvider(dir, "untrusted_provider") })
  counters.untrusted_provider = 0

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel("untrusted_provider", "test")
      await expect(Provider.getLanguage(model)).rejects.toBeInstanceOf(Provider.InitError)
      expect(counters.untrusted_provider).toBe(0)
    },
  })
})

test("loads a project provider module after trust", async () => {
  await using tmp = await tmpdir({ git: true, init: (dir) => writeProjectProvider(dir, "trusted_provider") })
  counters.trusted_provider = 0
  TrustFlag.set(true)

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel("trusted_provider", "test")
      await Provider.getLanguage(model)
      expect(counters.trusted_provider).toBe(1)
    },
  })
})
