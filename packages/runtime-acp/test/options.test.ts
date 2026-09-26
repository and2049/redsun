import { describe, expect, test } from "bun:test"
import { AcpOptions } from "../src/options.js"
import { ConfigAcp } from "@opencode/schema/config/acp"
import { Schema } from "effect"

describe("ACP agent options", () => {
  test("preserves prompt selection through public configuration decoding", () => {
    const decode = Schema.decodeUnknownSync(ConfigAcp.Info)
    const configured = decode({
      agents: { kiro: { preset: "kiro", prompt: "none" }, other: { command: "agent", prompt: "prefix" } },
    })
    expect(AcpOptions.parse(configured).agents.map((agent) => agent.prompt)).toEqual(["none", "prefix"])
    expect(() => decode({ agents: { other: { command: "agent", prompt: "replace" } } })).toThrow()
  })
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
      prompt: "prefix",
      compactCommand: "/compact",
      inheritedInstructions: [],
    })
    expect(AcpOptions.hasNativeApproval(kiro!)).toBe(false)
    // No approval mode or flag of its own: it always launches standard and the host answers its asks.
    expect(kiro!.autoApprovalArgs).toBeUndefined()
    expect(kiro!.autoApprovalMode).toBeUndefined()
    expect(AcpOptions.launchArgs(kiro!, "auto")).toEqual([])
    expect(AcpOptions.launchArgs(kiro!, "native_auto")).toEqual([])
    expect(AcpOptions.launchArgs(kiro!, "normal")).toEqual([])
    expect(kiro!.home?.env).toBe("KIRO_HOME")
    expect(kiro!.home?.path).toBe(AcpOptions.defaultHome("kiro"))
    expect(JSON.parse(kiro!.home!.files["agents/redsun.json"]!)).toMatchObject({
      name: "redsun",
      tools: ["@redsun"],
      allowedTools: ["@redsun"],
      resources: [],
    })
    expect(JSON.parse(kiro!.home!.files["settings/cli.json"]!)).toEqual({
      "chat.disableInheritingDefaultResources": true,
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

  test("offers native_auto only for a judgement-based mode on an agent with tools of its own", () => {
    const parse = (entry: Record<string, unknown>) =>
      AcpOptions.parse({ agents: { a: { command: "agent", ...entry } } }).agents[0]!
    expect(AcpOptions.hasNativeApproval(parse({}))).toBe(false)
    expect(AcpOptions.hasNativeApproval(parse({ native_approval_mode: "smart" }))).toBe(true)
    expect(AcpOptions.hasNativeApproval(parse({ native_approval_args: ["--smart"] }))).toBe(true)
    expect(AcpOptions.hasNativeApproval(parse({ native_approval_mode: "smart", host_tools: "all" }))).toBe(false)
    expect(AcpOptions.hasNativeApproval(parse({ auto_approval_mode: "yolo" }))).toBe(false)
    const both = parse({ native_approval_mode: "smart", auto_approval_mode: "yolo", auto_approval_args: ["-y"] })
    expect(AcpOptions.sessionMode(both, "native_auto")).toBe("smart")
    expect(AcpOptions.sessionMode(both, "auto")).toBe("yolo")
    expect(AcpOptions.sessionMode(both, "normal")).toBeUndefined()
    expect(AcpOptions.launchArgs(both, "auto")).toEqual(["-y"])
  })

  test("sends no base prompt unless an agent asks for it as a prefix", () => {
    const parse = (entry: Record<string, unknown>) =>
      AcpOptions.parse({ agents: { a: { command: "agent", ...entry } } }).agents[0]!
    expect(parse({}).prompt).toBe("none")
    expect(parse({ prompt: "prefix" }).prompt).toBe("prefix")
    expect(parse({ prompt: "system" }).prompt).toBe("none")
    expect(AcpOptions.parse({ agents: { kiro: { preset: "kiro" } } }).agents[0]!.prompt).toBe("prefix")
    expect(AcpOptions.parse({ agents: { kiro: { preset: "kiro", prompt: "none" } } }).agents[0]!.prompt).toBe("none")
  })
})
