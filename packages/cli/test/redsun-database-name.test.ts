import { describe, expect, it } from "bun:test"
import { INSTALLED_DATABASE, LOCAL_DATABASE, databaseFilename } from "../src/server-process"

describe("database filename", () => {
  // Two properties are load-bearing here.
  //
  // There are exactly two databases -- local development and installed --
  // because redsun removed the channel as an identity axis. Upstream derives the
  // name from the channel, which hands every branch and preview build its own
  // empty database.
  //
  // And the installed name has to stay `redsun-release.db`, because that is the
  // file V0.3.0 users already have. V2 does not start a new database: it opens
  // V1's and migrates it in place. If this drifts -- back to upstream's
  // `opencode*.db`, or forward to a tidier `redsun.db` -- an upgrading user gets
  // a machine that looks brand new rather than one that looks broken, which is
  // the harder failure to diagnose.
  const env = {}

  it("names the two databases", () => {
    expect(LOCAL_DATABASE).toBe("redsun-local.db")
    expect(INSTALLED_DATABASE).toBe("redsun-release.db")
  })

  it("gives a local development build its own database", () => {
    expect(databaseFilename("local", env)).toBe(LOCAL_DATABASE)
  })

  it("points every installed build at the one V0.3.0 wrote", () => {
    // `release` is what the publish workflow stamps; the rest are channels
    // upstream would have split off into separate files.
    for (const channel of ["release", "latest", "beta", "prod", "dev", "next", "port/v2-phase1-runtime"])
      expect(databaseFilename(channel, env)).toBe(INSTALLED_DATABASE)
  })

  it("collapses a local build onto the installed database when asked", () => {
    expect(databaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(INSTALLED_DATABASE)
    expect(databaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: "true" })).toBe(INSTALLED_DATABASE)
    expect(databaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: "0" })).toBe(LOCAL_DATABASE)
  })

  it("lets an explicit path win over everything", () => {
    // The dry-run harness for the V1 migration depends on this.
    expect(databaseFilename("release", { OPENCODE_DB: "/tmp/dryrun.db", OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(
      "/tmp/dryrun.db",
    )
    expect(databaseFilename("local", { OPENCODE_DB: ":memory:" })).toBe(":memory:")
  })
})
