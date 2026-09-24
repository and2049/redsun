import { describe, expect, test } from "bun:test"
import { AcpOptions } from "../src/options.js"

describe("ACP agent options", () => {
  test("the kiro preset confines Kiro to redsun's tools in a home redsun owns", () => {
    const { agents, errors } = AcpOptions.parse({ agents: { kiro: { preset: "kiro" } } })
    expect(errors).toEqual([])
    const [kiro] = agents
    expect(kiro).toMatchObject({
      id: "kiro",
      name: "Kiro-cli",
      command: "kiro-cli",
      args: ["acp", "--agent", "redsun"],
      hostTools: "all",
      compactCommand: "/compact",
      inheritedInstructions: [],
    })
    expect(AcpOptions.hasNativeApproval(kiro!)).toBe(false)
    expect(kiro!.home?.env).toBe("KIRO_HOME")
    expect(kiro!.home?.path).toBe(AcpOptions.defaultHome("kiro"))
    expect(JSON.parse(kiro!.home!.files["agents/redsun.json"]!)).toMatchObject({
      name: "redsun",
      tools: ["@redsun"],
      allowedTools: ["@redsun"],
    })
  })

  test("an entry's own keys override its preset; env and home merge", () => {
    const { agents } = AcpOptions.parse({
      agents: {
        kiro: { preset: "kiro", name: "Kiro", env: { XDG_DATA_HOME: "/data" }, home: { path: "~/kiro-home" } },
      },
    })
    expect(agents[0]).toMatchObject({ name: "Kiro", command: "kiro-cli", env: { XDG_DATA_HOME: "/data" } })
    expect(agents[0]!.home?.env).toBe("KIRO_HOME")
    expect(agents[0]!.home?.path).toEndWith("/kiro-home")
    expect(agents[0]!.home?.path.startsWith("~")).toBe(false)
  })

  test("reports an unknown preset and an agent without a command", () => {
    const { agents, errors } = AcpOptions.parse({ agents: { a: { preset: "nope" }, b: {} } })
    expect(agents).toEqual([])
    expect(errors).toEqual(['ACP agent "a" names an unknown preset "nope".', 'ACP agent "b" needs a command.'])
  })

  test("offers built-in agents whose command is installed, and lets config adjust or disable them", () => {
    expect(AcpOptions.withBuiltins({}, () => true)).toEqual({ kiro: { preset: "kiro" } })
    expect(AcpOptions.withBuiltins({}, () => false)).toEqual({})
    const adjusted = AcpOptions.parse({
      agents: AcpOptions.withBuiltins({ kiro: { host_tools: "extras", env: { A: "1" } } }, () => false),
    })
    expect(adjusted.agents[0]).toMatchObject({ id: "kiro", command: "kiro-cli", hostTools: "extras", env: { A: "1" } })
    expect(adjusted.agents[0]!.integration).toMatchObject({ name: "Kiro", whoami: ["whoami", "--format", "json"] })
    expect(
      AcpOptions.parse({ agents: AcpOptions.withBuiltins({ kiro: { enabled: false } }, () => true) }).agents,
    ).toEqual([])
  })
})
