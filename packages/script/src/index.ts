import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

if (process.versions.bun !== expectedBunVersion) {
  throw new Error(`This script requires bun@${expectedBunVersion}, but you are using bun@${process.versions.bun}`)
}

const CHANNEL = process.env["REDSUN_CHANNEL"] || "local"

const VERSION = process.env["REDSUN_VERSION"] || "0.0.0-local"

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
}
console.log(`redsun script`, JSON.stringify(Script, null, 2))
