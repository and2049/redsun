import { describe, expect, it } from "bun:test"
import { INSTALLER, INSTALLER_WINDOWS, RELEASE_API, REPOSITORY, versionFromRelease } from "../src/services/updater"

describe("updater release resolution", () => {
  it("points every upgrade source at the redsun repository", () => {
    expect(REPOSITORY).toBe("and2049/redsun")
    for (const url of [RELEASE_API, INSTALLER, INSTALLER_WINDOWS]) {
      expect(url).toContain(REPOSITORY)
      expect(url).not.toContain("opencode.ai")
    }
  })

  it("reads the release tag as a version", () => {
    expect(versionFromRelease({ tag_name: "v1.2.3" })).toBe("1.2.3")
    expect(versionFromRelease({ tag_name: "1.2.3" })).toBe("1.2.3")
  })

  it("reports no version rather than guessing one", () => {
    expect(versionFromRelease(undefined)).toBeUndefined()
    expect(versionFromRelease({})).toBeUndefined()
    expect(versionFromRelease({ tag_name: "" })).toBeUndefined()
    expect(versionFromRelease({ tag_name: 3 })).toBeUndefined()
  })
})
