import { test, expect } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"

test("validates subagent_depth", () => {
  expect(Config.Info.parse({ subagent_depth: 0 }).subagent_depth).toBe(0)
  expect(() => Config.Info.parse({ subagent_depth: -1 })).toThrow()
  expect(() => Config.Info.parse({ subagent_depth: 1.5 })).toThrow()
})

test("creates a missing REDSUN_CONFIG_DIR", async () => {
  await using tmp = await tmpdir()
  const configDir = path.join(tmp.path, "missing-config")
  const previous = process.env["REDSUN_CONFIG_DIR"]
  process.env["REDSUN_CONFIG_DIR"] = configDir
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.get()
        expect((await fs.stat(configDir)).isDirectory()).toBe(true)
      },
    })
  } finally {
    if (previous === undefined) delete process.env["REDSUN_CONFIG_DIR"]
    else process.env["REDSUN_CONFIG_DIR"] = previous
  }
})

test.skipIf(process.platform === "win32")("ignores an inaccessible REDSUN_CONFIG_DIR", async () => {
  await using tmp = await tmpdir()
  const configDir = path.join(tmp.path, "inaccessible-config")
  await fs.mkdir(configDir)
  await fs.chmod(configDir, 0o000)
  const previous = process.env["REDSUN_CONFIG_DIR"]
  process.env["REDSUN_CONFIG_DIR"] = configDir
  try {
    await Instance.provide({ directory: tmp.path, fn: () => Config.get() })
  } finally {
    await fs.chmod(configDir, 0o755)
    if (previous === undefined) delete process.env["REDSUN_CONFIG_DIR"]
    else process.env["REDSUN_CONFIG_DIR"] = previous
  }
})

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.username).toBeDefined()
    },
  })
})

test("loads JSON config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          model: "test/model",
          username: "testuser",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("loads JSONC config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.jsonc"),
        `{
        // This is a comment
        "$schema": "https://redsun.sh/config.json",
        "model": "test/model",
        "username": "testuser"
      }`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")
      expect(config.username).toBe("testuser")
    },
  })
})

test("merges multiple config files with correct precedence", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.jsonc"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          model: "base",
          username: "base",
        }),
      )
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          model: "override",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("override")
      expect(config.username).toBe("base")
    },
  })
})

test("handles environment variable substitution", async () => {
  const originalEnv = process.env["TEST_VAR"]
  process.env["TEST_VAR"] = "test_theme"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            $schema: "https://redsun.sh/config.json",
            theme: "{env:TEST_VAR}",
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.theme).toBe("test_theme")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["TEST_VAR"] = originalEnv
    } else {
      delete process.env["TEST_VAR"]
    }
  }
})

test("handles file inclusion substitution", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "included.txt"), "test_theme")
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          theme: "{file:included.txt}",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.theme).toBe("test_theme")
    },
  })
})

test("validates config schema and throws on invalid fields", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          invalid_field: "should cause error",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Strict schema should throw an error for invalid fields
      await expect(Config.get()).rejects.toThrow()
    },
  })
})

test("throws error for invalid JSON", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "redsun.json"), "{ invalid json }")
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Config.get()).rejects.toThrow()
    },
  })
})

test("handles agent configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          agent: {
            test_agent: {
              model: "test/model",
              temperature: 0.7,
              description: "test agent",
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test_agent"]).toEqual({
        model: "test/model",
        temperature: 0.7,
        description: "test agent",
      })
    },
  })
})

test("handles command configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          command: {
            test_command: {
              template: "test template",
              description: "test command",
              agent: "test_agent",
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.command?.["test_command"]).toEqual({
        template: "test template",
        description: "test command",
        agent: "test_agent",
      })
    },
  })
})

test("migrates mode field to agent field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          mode: {
            test_mode: {
              model: "test/model",
              temperature: 0.5,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test_mode"]).toEqual({
        model: "test/model",
        temperature: 0.5,
        mode: "primary",
      })
    },
  })
})

test("loads config from .redsun directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".redsun")
      await fs.mkdir(opencodeDir, { recursive: true })
      const agentDir = path.join(opencodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Bun.write(
        path.join(agentDir, "test.md"),
        `---
model: test/model
---
Test agent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]).toEqual({
        name: "test",
        model: "test/model",
        prompt: "Test agent prompt",
      })
    },
  })
})

test("updates config and writes to file", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const newConfig = { model: "updated/model" }
      await Config.update(newConfig as any)

      const writtenConfig = JSON.parse(await Bun.file(path.join(tmp.path, "redsun.json")).text())
      expect(writtenConfig.model).toBe("updated/model")
    },
  })
})

test("gets config directories", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = await Config.directories()
      expect(dirs.length).toBeGreaterThanOrEqual(1)
    },
  })
})

test("resolves scoped npm plugins in config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const pluginDir = path.join(dir, "node_modules", "@scope", "plugin")
      await fs.mkdir(pluginDir, { recursive: true })

      await Bun.write(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
      )

      await Bun.write(
        path.join(pluginDir, "package.json"),
        JSON.stringify(
          {
            name: "@scope/plugin",
            version: "1.0.0",
            type: "module",
            main: "./index.js",
          },
          null,
          2,
        ),
      )

      await Bun.write(path.join(pluginDir, "index.js"), "export default {}\n")

      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({ $schema: "https://redsun.sh/config.json", extension: ["./node_modules/@scope/plugin/index.js"] }, null, 2),
      )
    },
  })

    await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const extensionEntries = config.extension ?? []

      expect(extensionEntries.length).toBe(1)
      expect(extensionEntries[0]).toContain("/node_modules/@scope/plugin/")
    },
  })
})

test("merges extension arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .redsun config
      const projectDir = path.join(dir, "project")
      const opencodeDir = path.join(projectDir, ".redsun")
      await fs.mkdir(opencodeDir, { recursive: true })

      // Global config with extensions
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          extension: ["global-plugin-1", "global-plugin-2"],
        }),
      )

      // Local .redsun config with different extensions
      await Bun.write(
        path.join(opencodeDir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          extension: ["local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await Config.get()
      const extensions = config.extension ?? []

      // Should contain both global and local extensions
      expect(extensions.some((p: string) => p.includes("global-plugin-1"))).toBe(true)
      expect(extensions.some((p: string) => p.includes("global-plugin-2"))).toBe(true)
      expect(extensions.some((p: string) => p.includes("local-plugin-1"))).toBe(true)

      // Should have all 3 extensions (not replaced, but merged)
      const extensionNames = extensions.filter(
        (p: string) => p.includes("global-plugin") || p.includes("local-plugin"),
      )
      expect(extensionNames.length).toBeGreaterThanOrEqual(3)
    },
  })
})

test("does not error when only custom agent is a subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".redsun")
      await fs.mkdir(opencodeDir, { recursive: true })
      const agentDir = path.join(opencodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Bun.write(
        path.join(agentDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["helper"]).toEqual({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper subagent prompt",
      })
    },
  })
})

test("deduplicates duplicate extensions from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .redsun config
      const projectDir = path.join(dir, "project")
      const opencodeDir = path.join(projectDir, ".redsun")
      await fs.mkdir(opencodeDir, { recursive: true })

      // Global config with extensions
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          extension: ["duplicate-plugin", "global-plugin-1"],
        }),
      )

      // Local .redsun config with some overlapping extensions
      await Bun.write(
        path.join(opencodeDir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          extension: ["duplicate-plugin", "local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await Config.get()
      const extensions = config.extension ?? []

      // Should contain all unique extensions
      expect(extensions.some((p: string) => p.includes("global-plugin-1"))).toBe(true)
      expect(extensions.some((p: string) => p.includes("local-plugin-1"))).toBe(true)
      expect(extensions.some((p: string) => p.includes("duplicate-plugin"))).toBe(true)

      // Should deduplicate the duplicate extension
      const duplicateExtensions = extensions.filter((p: string) => p.includes("duplicate-plugin"))
      expect(duplicateExtensions.length).toBe(1)

      // Should have exactly 3 unique extensions
      const extensionNames = extensions.filter(
        (p: string) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
      )
      expect(extensionNames.length).toBe(3)
    },
  })
})

test("compaction config defaults to true when not specified", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      // When not specified, compaction should be undefined (defaults handled in usage)
      expect(config.compaction).toBeUndefined()
    },
  })
})

test("compaction config can disable auto compaction", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            auto: false,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.auto).toBe(false)
      expect(config.compaction?.prune).toBeUndefined()
    },
  })
})

test("compaction config can disable prune", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            prune: false,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.prune).toBe(false)
      expect(config.compaction?.auto).toBeUndefined()
    },
  })
})

test("compaction config can disable both auto and prune", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            auto: false,
            prune: false,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.auto).toBe(false)
      expect(config.compaction?.prune).toBe(false)
    },
  })
})

test("compaction config accepts strategy and keepRecent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            strategy: "algorithmic",
            keepRecent: 6,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.strategy).toBe("algorithmic")
      expect(config.compaction?.keepRecent).toBe(6)
    },
  })
})

test("compaction config accepts thresholds and maxToolResults", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            triggerThreshold: 0.75,
            resetThreshold: 0.35,
            maxToolResults: 12,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.triggerThreshold).toBe(0.75)
      expect(config.compaction?.resetThreshold).toBe(0.35)
      expect(config.compaction?.maxToolResults).toBe(12)
    },
  })
})

test("compaction config rejects resetThreshold greater than or equal to triggerThreshold", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            triggerThreshold: 0.6,
            resetThreshold: 0.6,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Config.get()).rejects.toThrow()
    },
  })
})

test("compaction config rejects triggerThreshold below default resetThreshold", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            triggerThreshold: 0.3,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Config.get()).rejects.toThrow()
    },
  })
})

test("compaction config strategy defaults to undefined (hybrid at usage)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.sh/config.json",
          compaction: {
            auto: true,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.compaction?.strategy).toBeUndefined()
      expect(config.compaction?.keepRecent).toBeUndefined()
    },
  })
})

test("provider options accept OpenAI-compatible cache control opt-in", () => {
  const parsed = Config.Info.parse({
    provider: {
      deepseek: {
        options: {
          openaiCompatibleCacheControl: true,
        },
      },
    },
  })

  expect(parsed.provider?.deepseek.options?.openaiCompatibleCacheControl).toBe(true)
})

test("provider options accept experimental OpenAI Responses continuation", () => {
  const parsed = Config.Info.parse({
    provider: {
      openai: {
        options: {
          experimentalResponsesContinuation: "api-only",
        },
      },
    },
  })

  expect(parsed.provider?.openai.options?.experimentalResponsesContinuation).toBe("api-only")
})
