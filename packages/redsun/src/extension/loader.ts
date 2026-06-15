import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { Config } from "../config/config"
import type { Extension } from "./types"
import path from "path"
import os from "os"
import { pathToFileURL, fileURLToPath } from "url"
import { BunProc } from "../bun"

export namespace ExtensionLoader {
  const log = Log.create({ service: "extension.loader" })

  export async function load(options?: { extraPaths?: string[]; projectTrusted?: boolean }): Promise<Extension.Loaded[]> {
    const loaded: Extension.Loaded[] = []
    const seen = new Set<string>()
    const config = await Config.get()

    // 1. Config extension entries
    for (const entry of config.extension ?? []) {
      await resolveEntry(entry, "user", loaded, seen)
    }

    // 2. CLI extra paths
    for (const entry of options?.extraPaths ?? []) {
      await resolveEntry(entry, "user", loaded, seen)
    }

    // 3. Global extensions
    const globalDir = path.join(Global.Path.home, ".redsun", "extensions")
    await discoverDirectory(globalDir, "user", loaded, seen)

    // 4. Project extensions (if trusted)
    if (options?.projectTrusted !== false) {
      await loadProjectExtensionsInto(loaded, seen)
    }

    return loaded
  }

  export async function loadProjectExtensions(): Promise<Extension.Loaded[]> {
    const loaded: Extension.Loaded[] = []
    const seen = new Set<string>()
    await loadProjectExtensionsInto(loaded, seen)
    return loaded
  }

  async function loadProjectExtensionsInto(loaded: Extension.Loaded[], seen: Set<string>) {
    const projectDir = path.join(Instance.directory, ".redsun", "extensions")
    await discoverDirectory(projectDir, "project", loaded, seen)
  }

  async function resolveEntry(
    entry: string,
    scope: Extension.SourceInfo["scope"],
    loaded: Extension.Loaded[],
    seen: Set<string>,
  ) {
    if (entry.startsWith("npm:")) {
      const specifier = entry.slice(4)
      await loadNpmPackage(specifier, loaded, seen)
      return
    }

    if (entry.startsWith("file:")) {
      const filePath = fileURLToPath(entry)
      await loadFile(filePath, scope, loaded, seen)
      return
    }

    // Assume filesystem path
    await loadFile(entry, scope, loaded, seen)
  }

  async function loadNpmPackage(specifier: string, loaded: Extension.Loaded[], seen: Set<string>) {
    const atIndex = specifier.lastIndexOf("@")
    const pkg = atIndex > 0 ? specifier.substring(0, atIndex) : specifier
    const version = atIndex > 0 ? specifier.substring(atIndex + 1) : "latest"

    const installedPath = await BunProc.install(pkg, version)
    const packageJsonPath = path.join(installedPath, "package.json")
    const manifest = await Bun.file(packageJsonPath)
      .json()
      .catch(() => null)

    const redsunManifest: Extension.Manifest | undefined = manifest?.redsun
    const entries = redsunManifest?.extensions ?? ["./index.ts"]

    for (const entry of entries) {
      const resolved = path.resolve(installedPath, entry)
      await loadFile(resolved, "npm", loaded, seen, installedPath)
    }
  }

  async function discoverDirectory(
    dir: string,
    scope: Extension.SourceInfo["scope"],
    loaded: Extension.Loaded[],
    seen: Set<string>,
  ) {
    const exists = await Bun.file(dir).exists()
    if (!exists) return

    const glob = new Bun.Glob("*.{ts,js}")
    for await (const match of glob.scan({ cwd: dir, absolute: true, onlyFiles: true })) {
      await loadFile(match, scope, loaded, seen)
    }

    const entries = await Array.fromAsync(
      new Bun.Glob("*").scan({
        cwd: dir,
        absolute: true,
        onlyFiles: false,
      }),
    )
    for (const match of entries) {
      const stat = await Bun.file(match).stat().catch(() => null)
      if (stat?.isDirectory()) {
        await loadDirectory(match, scope, loaded, seen)
      }
    }
  }

  async function loadDirectory(
    dir: string,
    scope: Extension.SourceInfo["scope"],
    loaded: Extension.Loaded[],
    seen: Set<string>,
  ) {
    const packageJsonPath = path.join(dir, "package.json")
    const hasPackageJson = await Bun.file(packageJsonPath).exists()

    if (hasPackageJson) {
      const manifest = await Bun.file(packageJsonPath).json().catch(() => null)
      const redsunManifest: Extension.Manifest | undefined = manifest?.redsun
      if (redsunManifest?.extensions) {
        for (const entry of redsunManifest.extensions) {
          const resolved = path.resolve(dir, entry)
          await loadFile(resolved, scope, loaded, seen, dir)
        }
        return
      }
    }

    // Default to index.ts / index.js
    for (const name of ["index.ts", "index.js"]) {
      const indexPath = path.join(dir, name)
      if (await Bun.file(indexPath).exists()) {
        await loadFile(indexPath, scope, loaded, seen, dir)
        return
      }
    }
  }

  async function loadFile(
    filePath: string,
    scope: Extension.SourceInfo["scope"],
    loaded: Extension.Loaded[],
    seen: Set<string>,
    sourcePath?: string,
  ) {
    const resolved = path.resolve(filePath)
    if (seen.has(resolved)) return
    seen.add(resolved)

    log.info("loading extension", { path: resolved })

    try {
      const mod = await import(pathToFileURL(resolved).href)
      const factory = mod.default ?? mod.extension
      if (typeof factory !== "function") {
        log.warn("extension has no default factory export", { path: resolved })
        return
      }

      loaded.push({
        path: filePath,
        resolvedPath: resolved,
        sourceInfo: { path: sourcePath ?? resolved, scope },
        factory,
      })
    } catch (error) {
      log.error("failed to load extension", { path: resolved, error })
    }
  }
}
