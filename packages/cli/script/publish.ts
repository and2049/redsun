#!/usr/bin/env bun
// REDSUN: releases are GitHub release assets, not npm packages.
//
// Upstream publishes `@opencode-ai/cli-<target>` to npm and lets the package
// manager do the install. Redsun cannot: probing for a package-manager upgrade
// path resolved the main `redsun` build to `@opencode-ai/cli`, so an autoupdate
// installed upstream OpenCode over redsun. So this produces exactly the archives
// dev produced -- `redsun-<target>.zip`, or `.tar.gz` on linux, each holding the
// single compiled binary -- which is what `install` and `install.ps1` download.
//
// The asset name is a contract with those two scripts: they compute
// `<os>-<arch>[-baseline][-musl]` themselves and fetch `redsun-<target><ext>`.
// The build writes to `dist/cli-<target>/`, keeping upstream's directory naming,
// so the only translation is the leading segment.
import { $ } from "bun"
import { existsSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const binary = "redsun"
const skipBuild = process.argv.includes("--skip-build")

if (!skipBuild) await import("./build.ts")

const targets: string[] = []
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  // Bun.Glob yields platform separators, so do not split on "/" by hand.
  const directory = path.dirname(filepath)
  if (!directory.startsWith("cli-")) continue
  targets.push(directory)
}
if (!targets.length) throw new Error("No build output found in dist; run script/build.ts first")

{
  const platform = process.platform === "win32" ? "windows" : process.platform
  const host = `cli-${platform}-${process.arch}`
  const executable = process.platform === "win32" ? `${binary}.exe` : binary
  const smoke = `./dist/${host}/bin/${executable}`
  if (!existsSync(smoke)) {
    // A cross-compiled-only build (a single foreign --target=) has nothing this
    // machine can execute; that is fine, but say so rather than passing quietly.
    console.log(`smoke test skipped: ${smoke} was not built on this host`)
  } else {
    console.log(`smoke test: running ${smoke} --version`)
    await $`${smoke} --version`
  }
}

// CI runs on ubuntu, where `zip` is present, but a maintainer checking the
// archives on Windows has no such thing. Compress-Archive covers that case.
async function zip(cwd: string, out: string, file: string) {
  if (Bun.which("zip")) return void (await $`zip -qr ${out} ${file}`.cwd(cwd))
  await $`powershell -NoProfile -NonInteractive -Command ${`Compress-Archive -Path '${file}' -DestinationPath '${out}' -Force`}`.cwd(
    cwd,
  )
}

const archives: string[] = []
for (const target of targets) {
  const asset = target.replace(/^cli-/, `${binary}-`)
  const executable = target.includes("windows") ? `${binary}.exe` : binary
  const source = `./dist/${target}/bin/${executable}`
  if (!existsSync(source)) throw new Error(`Missing ${source}`)
  if (process.platform !== "win32") await $`chmod 755 ${executable}`.cwd(`dist/${target}/bin`)
  // Only the executable goes in. `bin/` also holds the split chunks' sourcemaps,
  // which are debug output -- shipping them would multiply the download for
  // files the installers never move out of the temp directory.
  if (target.includes("linux")) {
    await $`tar -czf ../../${asset}.tar.gz ${executable}`.cwd(`dist/${target}/bin`)
    archives.push(`${asset}.tar.gz`)
  } else {
    await zip(`dist/${target}/bin`, `../../${asset}.zip`, executable)
    archives.push(`${asset}.zip`)
  }
}

console.log("Created release archives:")
for (const archive of archives) {
  const contents = archive.endsWith(".tar.gz")
    ? await $`tar -tzf dist/${archive}`.text()
    : await $`unzip -l dist/${archive}`.text()
  if (!contents.includes(binary)) throw new Error(`Archive ${archive} does not contain ${binary}`)
  console.log(`  validated ${archive}`)
}
