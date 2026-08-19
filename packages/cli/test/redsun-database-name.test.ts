import { describe, expect, it } from "bun:test"
import { INSTALLED_DATABASE, LOCAL_DATABASE, databaseFilename } from "../src/server-process"

describe("database filename", () => {
  const env = {}

  it("names the two databases", () => {
    expect(LOCAL_DATABASE).toBe("redsun-local.db")
    expect(INSTALLED_DATABASE).toBe("redsun-release.db")
  })

  it("gives a local development build its own database", () => {
    expect(databaseFilename("local", env)).toBe(LOCAL_DATABASE)
  })

  it("points every installed build at the one V0.3.0 wrote", () => {
    for (const channel of ["release", "latest", "beta", "prod", "dev", "next", "port/v2-phase1-runtime"])
      expect(databaseFilename(channel, env)).toBe(INSTALLED_DATABASE)
  })

  it("collapses a local build onto the installed database when asked", () => {
    expect(databaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(INSTALLED_DATABASE)
    expect(databaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: "true" })).toBe(INSTALLED_DATABASE)
    expect(databaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: "0" })).toBe(LOCAL_DATABASE)
  })

  it("lets an explicit path win over everything", () => {
    expect(databaseFilename("release", { OPENCODE_DB: "/tmp/dryrun.db", OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(
      "/tmp/dryrun.db",
    )
    expect(databaseFilename("local", { OPENCODE_DB: ":memory:" })).toBe(":memory:")
  })
})
