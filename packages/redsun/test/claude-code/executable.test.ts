import { describe, expect, test } from "bun:test"
import { ClaudeCodeExecutable } from "@/claude-code/executable"

function fakeFs(files: string[]) {
  const set = new Set(files.map((file) => file.toLowerCase()))
  return { isFile: (filePath: string) => set.has(filePath.toLowerCase()) }
}

describe("claude-code executable resolution", () => {
  test("windows npm shim is followed to the packaged native binary", () => {
    const result = ClaudeCodeExecutable.resolveWith({
      env: { Path: "C:\\Users\\dev\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32",
      filesystem: fakeFs([
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      ]),
    })
    expect(result).toEqual({
      path: "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    })
  })

  test("windows shim falls back to cli.js when no native binary is packaged", () => {
    const result = ClaudeCodeExecutable.resolveWith({
      env: { Path: "C:\\npm", PATHEXT: ".CMD" },
      platform: "win32",
      filesystem: fakeFs(["C:\\npm\\claude.cmd", "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"]),
    })
    expect(result).toEqual({ path: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" })
  })

  test("windows native exe on PATH is used directly", () => {
    const result = ClaudeCodeExecutable.resolveWith({
      env: { Path: "C:\\tools", PATHEXT: ".COM;.EXE;.CMD" },
      platform: "win32",
      filesystem: fakeFs(["C:\\tools\\claude.exe"]),
    })
    expect(result).toEqual({ path: "C:\\tools\\claude.exe" })
  })

  test("posix PATH scan returns the plain binary", () => {
    const result = ClaudeCodeExecutable.resolveWith({
      env: { PATH: "/usr/local/bin:/usr/bin" },
      platform: "linux",
      filesystem: fakeFs(["/usr/local/bin/claude"]),
    })
    expect(result).toEqual({ path: "/usr/local/bin/claude" })
  })

  test("configured explicit path wins and missing file is an actionable error", () => {
    const found = ClaudeCodeExecutable.resolveWith({
      binaryPath: "/opt/claude/claude",
      env: {},
      platform: "linux",
      filesystem: fakeFs(["/opt/claude/claude"]),
    })
    expect(found).toEqual({ path: "/opt/claude/claude" })

    const missing = ClaudeCodeExecutable.resolveWith({
      binaryPath: "/opt/claude/claude",
      env: {},
      platform: "linux",
      filesystem: fakeFs([]),
    })
    expect("error" in missing && missing.error).toContain("binary_path")
  })

  test("missing binary reports an install hint", () => {
    const result = ClaudeCodeExecutable.resolveWith({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      filesystem: fakeFs([]),
    })
    expect("error" in result && result.error).toContain("claude")
  })
})
