import { $ } from "bun"
import path from "path"
import fsSync from "fs"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const LARGE_UNTRACKED_FILE = 2 * 1024 * 1024
  const locks = new Map<string, Promise<void>>()

  async function locked<T>(fn: () => Promise<T>) {
    const key = gitdir()
    const previous = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const tail = previous.then(() => gate)
    locks.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (locks.get(key) === tail) locks.delete(key)
    }
  }

  type GitResult = { exitCode: number; text: string; stderr: string }

  async function runGit(
    args: string[],
    options: { snapshot?: boolean; cwd?: string; stdin?: string } = {},
  ): Promise<GitResult> {
    const env = { ...process.env }
    if (options.snapshot !== false) {
      env.GIT_DIR = gitdir()
      env.GIT_WORK_TREE = Instance.worktree
    } else {
      delete env.GIT_DIR
      delete env.GIT_WORK_TREE
    }
    const proc = Bun.spawn(["git", ...args], {
      cwd: options.cwd ?? Instance.directory,
      env,
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (options.stdin !== undefined) {
      proc.stdin?.write(options.stdin)
      proc.stdin?.end()
    }
    const [exitCode, text, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, text, stderr }
  }

  const nul = (paths: string[]) => paths.join("\0") + "\0"
  const literalPathspecs = (paths: string[]) => nul(paths.map((item) => `:(top,literal)${item}`))

  async function ignored(paths: string[]) {
    if (!paths.length) return new Set<string>()
    const protectedPaths = paths.map((item) => (item.startsWith(":") ? `./${item}` : item))
    const result = await runGit(
      ["-c", "core.quotepath=false", "check-ignore", "--no-index", "--stdin", "-z"],
      { snapshot: false, cwd: Instance.worktree, stdin: nul(protectedPaths) },
    )
    if (result.exitCode !== 0 && result.exitCode !== 1) return new Set<string>()
    return new Set(
      result.text
        .split("\0")
        .filter(Boolean)
        .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
    )
  }

  async function stageChanges() {
    const [changed, other] = await Promise.all([
      runGit(["-c", "core.quotepath=false", "diff-files", "--name-only", "-z", "--", "."]),
      runGit(["-c", "core.quotepath=false", "ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."]),
    ])
    if (changed.exitCode !== 0 || other.exitCode !== 0) {
      log.warn("failed to list snapshot files", {
        changed: changed.stderr,
        untracked: other.stderr,
      })
      return
    }
    const tracked = changed.text.split("\0").filter(Boolean)
    const untracked = other.text.split("\0").filter(Boolean)
    const candidates = Array.from(new Set([...tracked, ...untracked]))
    if (!candidates.length) return

    const ignoredFiles = await ignored(candidates)
    if (ignoredFiles.size > 0) {
      await runGit(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: Instance.worktree,
        stdin: literalPathspecs(Array.from(ignoredFiles)),
      })
    }

    const allowed = candidates.filter((item) => !ignoredFiles.has(item))
    const untrackedSet = new Set(untracked)
    const stage = []
    for (const item of allowed) {
      const stat = await fs.stat(path.join(Instance.worktree, item)).catch(() => undefined)
      if (untrackedSet.has(item) && stat?.isFile() && stat.size > LARGE_UNTRACKED_FILE) continue
      stage.push(item)
    }
    if (!stage.length) return
    const result = await runGit(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: Instance.worktree,
      stdin: literalPathspecs(stage),
    })
    if (result.exitCode !== 0) log.warn("failed to stage snapshot files", { stderr: result.stderr })
  }

  async function seedSnapshot() {
    const common = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      snapshot: false,
      cwd: Instance.worktree,
    })
    if (common.exitCode !== 0) return
    const source = common.text.trim()
    if (!source) return
    const objects = path.join(source, "objects")
    const alternates = [
      objects,
      ...(await Bun.file(path.join(objects, "info", "alternates"))
        .text()
        .catch(() => ""))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ]
    const existing = []
    for (const candidate of alternates) {
      if (await fs.stat(candidate).then(() => true).catch(() => false)) existing.push(candidate)
    }
    if (existing.length) {
      await fs.mkdir(path.join(gitdir(), "objects", "info"), { recursive: true })
      await Bun.write(path.join(gitdir(), "objects", "info", "alternates"), existing.join("\n") + "\n")
    }
    await fs.copyFile(path.join(source, "index"), path.join(gitdir(), "index")).catch(() => {})
  }

  export async function track() {
    return locked(async () => {
      if (Instance.project.vcs !== "git") return
      const cfg = await Config.get()
      if (cfg.snapshot === false) return
      const git = gitdir()
      if (await fs.mkdir(git, { recursive: true })) {
        await $`git init`
          .env({
            ...process.env,
            GIT_DIR: git,
            GIT_WORK_TREE: Instance.worktree,
          })
          .quiet()
          .nothrow()
        // Configure git for cross-platform compatibility
        await $`git --git-dir ${git} config core.autocrlf false`.quiet().nothrow()
        await $`git --git-dir ${git} config core.longpaths true`.quiet().nothrow()
        await $`git --git-dir ${git} config core.symlinks true`.quiet().nothrow()
        await $`git --git-dir ${git} config core.fsmonitor false`.quiet().nothrow()
        await $`git --git-dir ${git} config feature.manyFiles true`.quiet().nothrow()
        await $`git --git-dir ${git} config index.version 4`.quiet().nothrow()
        await seedSnapshot()
        log.info("initialized")
      }
      await stageChanges()
      const hash = await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
        .text()
      log.info("tracking", { hash, cwd: Instance.directory, git })
      return hash.trim()
    })
  }

  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export async function patch(hash: string): Promise<Patch> {
    return locked(async () => {
      const git = gitdir()
      await stageChanges()
      const result =
        await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --cached --no-ext-diff --name-only ${hash} -- .`
          .quiet()
          .cwd(Instance.directory)
          .nothrow()

    // If git diff fails, return empty patch
      if (result.exitCode !== 0) {
        log.warn("failed to get diff", { hash, exitCode: result.exitCode })
        return { hash, files: [] }
      }

      const files = result.text()
      const relative = files
        .trim()
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
      const ignoredFiles = await ignored(relative)
      return {
        hash,
        files: relative
          .filter((item) => !ignoredFiles.has(item))
          .map((x) => path.join(Instance.worktree, x).replaceAll("\\", "/")),
      }
    })
  }

  export async function restore(snapshot: string) {
    return locked(async () => {
      log.info("restore", { commit: snapshot })
      const git = gitdir()
      const result =
        await $`git --git-dir ${git} --work-tree ${Instance.worktree} read-tree ${snapshot} && git --git-dir ${git} --work-tree ${Instance.worktree} checkout-index -a -f`
          .quiet()
          .cwd(Instance.worktree)
          .nothrow()

      if (result.exitCode !== 0) {
        log.error("failed to restore snapshot", {
          snapshot,
          exitCode: result.exitCode,
          stderr: result.stderr.toString(),
          stdout: result.stdout.toString(),
        })
      }
    })
  }

  export async function revert(patches: Patch[]) {
    return locked(async () => {
      const files = new Set<string>()
      const git = gitdir()
      for (const item of patches) {
        for (const file of item.files) {
          if (files.has(file)) continue
          log.info("reverting", { file, hash: item.hash })
          const relPath = path.relative(Instance.worktree, file).replaceAll("\\", "/")
          const result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} checkout ${item.hash} -- ${relPath}`
            .quiet()
            .cwd(Instance.worktree)
            .nothrow()
          if (result.exitCode !== 0) {
            const checkTree =
              await $`git --git-dir ${git} --work-tree ${Instance.worktree} ls-tree ${item.hash} -- ${relPath}`
                .quiet()
                .cwd(Instance.worktree)
                .nothrow()
            if (checkTree.exitCode === 0 && checkTree.text().trim()) {
              log.info("file existed in snapshot but checkout failed, keeping", {
                file,
              })
            } else {
              log.info("file did not exist in snapshot, deleting", { file })
              await fs.unlink(file).catch(() => {})
            }
          }
          files.add(file)
        }
      }
    })
  }

  export async function diff(hash: string) {
    return locked(async () => {
      const git = gitdir()
      await stageChanges()
      const result =
        await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --cached --no-ext-diff ${hash} -- .`
          .quiet()
          .cwd(Instance.worktree)
          .nothrow()

      if (result.exitCode !== 0) {
        log.warn("failed to get diff", {
          hash,
          exitCode: result.exitCode,
          stderr: result.stderr.toString(),
          stdout: result.stdout.toString(),
        })
        return ""
      }

      return result.text().trim()
    })
  }

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>
  export async function diffFull(from: string, to: string): Promise<FileDiff[]> {
    return locked(async () => {
      const git = gitdir()
      const rows: { additions: string; deletions: string; file: string }[] = []
      for await (const line of $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --no-renames --numstat ${from} ${to} -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
        .lines()) {
        if (!line) continue
        const [additions, deletions, file] = line.split("\t")
        if (!file) continue
        rows.push({ additions, deletions, file })
      }
      const ignoredFiles = await ignored(rows.map((row) => row.file))
      const result: FileDiff[] = []
      for (const row of rows) {
        if (ignoredFiles.has(row.file)) continue
        const isBinaryFile = row.additions === "-" && row.deletions === "-"
        const before = isBinaryFile
          ? ""
          : await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} show ${from}:${row.file}`
              .quiet()
              .nothrow()
              .text()
        const after = isBinaryFile
          ? ""
          : await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} show ${to}:${row.file}`
              .quiet()
              .nothrow()
              .text()
        result.push({
          file: row.file,
          before,
          after,
          additions: isBinaryFile ? 0 : parseInt(row.additions),
          deletions: isBinaryFile ? 0 : parseInt(row.deletions),
        })
      }
      return result
    })
  }

  function gitdir() {
    const project = Instance.project
    const base = path.join(Global.Path.data, "snapshot", project.id)
    const worktree = path.resolve(Instance.worktree).replaceAll("\\", "/")
    const marker = `${base}.worktree`
    fsSync.mkdirSync(path.dirname(base), { recursive: true })
    try {
      fsSync.writeFileSync(marker, worktree, { flag: "wx" })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
    const owner = fsSync.readFileSync(marker, "utf8").trim()
    if (owner === worktree) return base
    return `${base}-${Bun.hash(worktree).toString(16)}`
  }
}
