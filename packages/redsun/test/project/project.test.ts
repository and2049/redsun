import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { detectProfile } from "../../src/project/toolchain"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Project.fromDirectory", () => {
  test("should handle git repository with no commits", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()

    const project = await Project.fromDirectory(tmp.path)

    expect(project).toBeDefined()
    expect(project.id).toBe("global")
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)

    const opencodeFile = path.join(tmp.path, ".git", "opencode")
    const fileExists = await Bun.file(opencodeFile).exists()
    expect(fileExists).toBe(false)
  })

  test("should handle git repository with commits", async () => {
    await using tmp = await tmpdir({ git: true })

    const project = await Project.fromDirectory(tmp.path)

    expect(project).toBeDefined()
    expect(project.id).not.toBe("global")
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)

    const opencodeFile = path.join(tmp.path, ".git", "opencode")
    const fileExists = await Bun.file(opencodeFile).exists()
    expect(fileExists).toBe(true)
  })
})

describe("Project.discover", () => {
  test("should discover favicon.png in root", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = await Project.fromDirectory(tmp.path)

    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await Bun.write(path.join(tmp.path, "favicon.png"), pngData)

    await Project.discover(project)

    const updated = await Storage.read<Project.Info>(["project", project.id])
    expect(updated.icon).toBeDefined()
    expect(updated.icon?.url).toStartWith("data:")
    expect(updated.icon?.url).toContain("base64")
    expect(updated.icon?.color).toBeUndefined()
  })

  test("should not discover non-image files", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = await Project.fromDirectory(tmp.path)

    await Bun.write(path.join(tmp.path, "favicon.txt"), "not an image")

    await Project.discover(project)

    const updated = await Storage.read<Project.Info>(["project", project.id])
    expect(updated.icon).toBeUndefined()
  })
})

describe("toolchain.detectProfile", () => {
  test("detects Bun project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "bun.lock"), "")
      },
    })
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBe("bun test")
    expect(profile.typecheck).toBe("bunx tsc --noEmit")
    expect(profile.build).toBe("bun run build")
  })

  test("detects npm project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name: "test" }))
        await Bun.write(path.join(dir, "package-lock.json"), "")
      },
    })
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBe("npm test")
  })

  test("reads package.json scripts when present", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "package.json"), JSON.stringify({
          name: "test",
          scripts: { test: "vitest", build: "vite build", lint: "eslint ." },
        }))
        await Bun.write(path.join(dir, "package-lock.json"), "")
      },
    })
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBe("npm run test")
    expect(profile.build).toBe("npm run build")
    expect(profile.lint).toBe("npm run lint")
  })

  test("detects Cargo project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "Cargo.toml"), '[package]\nname = "test"')
      },
    })
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBe("cargo test")
    expect(profile.build).toBe("cargo build")
    expect(profile.lint).toBe("cargo clippy")
    expect(profile.typecheck).toBe("cargo check")
  })

  test("detects Go project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "go.mod"), "module test\n\ngo 1.21")
      },
    })
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBe("go test ./...")
    expect(profile.build).toBe("go build ./...")
    expect(profile.lint).toBe("go vet ./...")
    expect(profile.typecheck).toBe("go build ./...")
    expect(profile.format).toBe("gofmt -w -l .")
  })

  test("detects Python uv project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "pyproject.toml"), "[project]\nname = \"test\"")
        await Bun.write(path.join(dir, "uv.lock"), "")
      },
    })
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBe("uv run pytest")
    expect(profile.lint).toBe("uv run ruff check .")
    expect(profile.format).toBe("uv run ruff format --check .")
  })

  test("returns null commands for unknown project", async () => {
    await using tmp = await tmpdir()
    const profile = await detectProfile(tmp.path)
    expect(profile.test).toBeNull()
    expect(profile.build).toBeNull()
    expect(profile.lint).toBeNull()
    expect(profile.typecheck).toBeNull()
    expect(profile.format).toBeNull()
  })
})
