#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const { binaries } = await import("./build.ts")

{
  const platformName = process.platform === "win32" ? "windows" : process.platform
  const name = `${pkg.name}-${platformName}-${process.arch}`
  const binary = process.platform === "win32" ? `${pkg.name}.exe` : pkg.name
  console.log(`smoke test: running dist/${name}/bin/${binary} --version`)
  await $`./dist/${name}/bin/${binary} --version`
}

for (const key of Object.keys(binaries)) {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`dist/${key}`)
  }
  if (key.includes("linux")) {
    await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
  } else {
    await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
  }
}

console.log("Created release archives:")
for (const key of Object.keys(binaries)) {
  const ext = key.includes("linux") ? "tar.gz" : "zip"
  const archive = `dist/${key}.${ext}`
  if (key.includes("linux")) {
    const contents = await $`tar -tzf ${archive}`.text()
    if (!contents.includes(pkg.name)) {
      throw new Error(`Archive ${key}.${ext} does not contain ${pkg.name}`)
    }
  } else {
    const contents = await $`unzip -l ${archive}`.text()
    if (!contents.includes(pkg.name)) {
      throw new Error(`Archive ${key}.${ext} does not contain ${pkg.name}`)
    }
  }
  console.log(`  validated ${key}.${ext}`)
}

// --- npm publishing (uncomment after setting up npm account) ---
// await $`mkdir -p ./dist/${pkg.name}`
// await $`cp -r ./bin ./dist/${pkg.name}/bin`
// await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
//
// await Bun.file(`./dist/${pkg.name}/package.json`).write(
//   JSON.stringify(
//     {
//       name: pkg.name,
//       bin: { [pkg.name]: `./bin/${pkg.name}` },
//       scripts: { postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs" },
//       version: Script.version,
//       optionalDependencies: binaries,
//     },
//     null,
//     2,
//   ),
// )
//
// const tasks = Object.entries(binaries).map(async ([name]) => {
//   if (process.platform !== "win32") {
//     await $`chmod -R 755 .`.cwd(`./dist/${name}`)
//   }
//   await $`bun pm pack`.cwd(`./dist/${name}`)
//   await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(`./dist/${name}`)
// })
// await Promise.all(tasks)
// await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`
