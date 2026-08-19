#!/usr/bin/env bun
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
    console.log(`smoke test skipped: ${smoke} was not built on this host`)
  } else {
    console.log(`smoke test: running ${smoke} --version`)
    await $`${smoke} --version`
  }
}

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
