import path from "path"
import os from "os"
import { Log } from "../util/log"
import { Global } from "../global"
import { BunProc } from "../bun"
import { pathToFileURL } from "url"

export namespace ExtensionInstall {
  const log = Log.create({ service: "extension.install" })

  export async function install(specifier: string): Promise<{ success: boolean; message: string; path?: string }> {
    if (specifier.startsWith("npm:")) {
      return installNpm(specifier.slice(4))
    }
    if (specifier.startsWith("file:")) {
      return installFile(specifier.slice(5))
    }
    return { success: false, message: `Unknown specifier: ${specifier}. Use npm:package or file:./path` }
  }

  async function installNpm(specifier: string): Promise<{ success: boolean; message: string; path?: string }> {
    log.info("installing npm extension", { specifier })
    try {
      const atIndex = specifier.lastIndexOf("@")
      const pkg = atIndex > 0 ? specifier.substring(0, atIndex) : specifier
      const version = atIndex > 0 ? specifier.substring(atIndex + 1) : "latest"

      const installedPath = await BunProc.install(pkg, version)
      const extensionsDir = path.join(Global.Path.home, ".redsun", "extensions")

      await Bun.$`mkdir -p ${extensionsDir}`.quiet()

      const pkgJsonPath = path.join(installedPath, "package.json")
      const manifest = await Bun.file(pkgJsonPath).json().catch(() => null)
      const redsunManifest = manifest?.redsun
      const entries = redsunManifest?.extensions ?? ["./index.ts"]

      for (const entry of entries) {
        const srcPath = path.resolve(installedPath, entry)
        const entryName = entry.replace(/^\.\//, "").replace(/\//g, "-").replace(/\.[^.]+$/, "")
        const destName = `${pkg.replace("/", "-")}-${entryName}.ts`
        const destPath = path.join(extensionsDir, destName)
        const sourceURL = pathToFileURL(srcPath).href
        await Bun.write(
          destPath,
          `import * as extension from ${JSON.stringify(sourceURL)}\nexport default extension.default ?? extension.extension\n`,
        )
        log.info("installed extension shim", { srcPath, destPath })
      }

      return { success: true, message: `Installed ${specifier}`, path: extensionsDir }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error("npm install failed", { specifier, error: message })
      return { success: false, message: `Failed to install ${specifier}: ${message}` }
    }
  }

  async function installFile(filePath: string): Promise<{ success: boolean; message: string; path?: string }> {
    log.info("installing file extension", { filePath })
    try {
      const resolved = path.resolve(filePath)
      const stat = await Bun.file(resolved).stat().catch(() => null)
      if (!stat) {
        return { success: false, message: `File not found: ${filePath}` }
      }

      const extensionsDir = path.join(Global.Path.home, ".redsun", "extensions")
      await Bun.$`mkdir -p ${extensionsDir}`.quiet()

      const destName = path.basename(resolved)
      const destPath = path.join(extensionsDir, destName)
      await Bun.$`cp ${resolved} ${destPath}`.quiet()

      return { success: true, message: `Installed ${path.basename(resolved)}`, path: destPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, message: `Failed to install ${filePath}: ${message}` }
    }
  }
}
