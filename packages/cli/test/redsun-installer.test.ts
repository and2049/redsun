import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { INSTALLER, INSTALLER_WINDOWS, REPOSITORY } from "../src/services/updater"

// The port arrived carrying upstream's v2 installer, which installs
// `@opencode-ai/cli-<target>` from npm -- upstream OpenCode, not redsun -- with
// only `APP=redsun` and the install directory rebranded. `redsun upgrade`
// downloads and runs whichever of these two files matches the platform, so a
// drifted installer does not fail: it quietly replaces redsun with something
// else. That is the failure this file exists to catch.
const root = path.resolve(import.meta.dir, "../../..")
const read = (name: string) => readFileSync(path.join(root, name), "utf8")

describe("installers", () => {
  const scripts = [
    { name: "install", text: read("install") },
    { name: "install.ps1", text: read("install.ps1") },
  ]

  it("ships both platforms' installers", () => {
    // `Updater.INSTALLER_WINDOWS` has nothing to fetch without the second one.
    for (const script of scripts) expect(script.text.length).toBeGreaterThan(0)
  })

  it("installs redsun from the redsun repository", () => {
    for (const script of scripts) {
      expect(script.text).toContain(REPOSITORY)
      expect(script.text).toContain(".redsun")
    }
  })

  it("takes no package manager or upstream path", () => {
    for (const script of scripts) {
      for (const forbidden of ["registry.npmjs.org", "@opencode-ai", "opencode.ai", "anomalyco"]) {
        expect(script.text).not.toContain(forbidden)
      }
    }
  })

  it("asks for the asset name the release actually publishes", () => {
    // `packages/cli/script/publish.ts` renames each `dist/cli-<target>` into
    // `redsun-<target>.zip` (`.tar.gz` on linux) for exactly this reason: the
    // two sides compute the name independently and only meet on the release.
    expect(scripts[0]!.text).toContain('filename="$APP-$target$archive_ext"')
    expect(scripts[1]!.text).toContain('$filename = "$App-$target$archiveExt"')
    const publish = read(path.join("packages", "cli", "script", "publish.ts"))
    expect(publish).toContain("target.replace(/^cli-/, `${binary}-`)")
  })

  it("is reachable at the URL the updater fetches", () => {
    // The workflow attaches both files to the release, so `latest/download`
    // resolves. Fetching them from a branch instead would depend on the default
    // branch name and could hand an old install a newer installer.
    expect(INSTALLER).toBe(`https://github.com/${REPOSITORY}/releases/latest/download/install`)
    expect(INSTALLER_WINDOWS).toBe(`https://github.com/${REPOSITORY}/releases/latest/download/install.ps1`)
    const workflow = read(path.join(".github", "workflows", "publish.yml"))
    expect(workflow).toContain("install.ps1")
    expect(workflow).toContain("packages/cli/dist/*.zip")
    expect(workflow).toContain("REDSUN_CHANNEL: release")
  })
})
