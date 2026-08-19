import { afterEach, describe, expect, test } from "bun:test"
import { For } from "solid-js"
import { testRender, type JSX } from "@opentui/solid"
import {
  InlineToolRow,
  TRANSCRIPT_GUTTER,
  executeCallSummary,
  isBackgroundSubagent,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  thinkingTeaser,
  toolDisplay,
} from "../../../src/routes/session"
import { primitiveInputSummary } from "../../../src/util/tool-display"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type ToolFixture = { icon: string; label: string; error?: string }

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
  },
] as const

function Fixture(props: { errorExpanded?: boolean }) {
  return (
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        <For each={tools}>
          {(item) => (
            <InlineToolRow
              icon={item.icon}
              complete={true}
              pending=""
              failed={Boolean(item.error)}
              error={item.error}
              errorExpanded={props.errorExpanded}
            >
              {item.label}
            </InlineToolRow>
          )}
        </For>
      </box>
    </box>
  )
}

function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="%" complete={false} pending="Preparing patch..." failed={true} failure="Patch failed">
      Patch
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Reading file..." failed={true} failure="Read failed">
      Read src/index.ts
    </InlineToolRow>
  )
}

function NamedToolFixture(props: { failed?: boolean }) {
  return (
    <InlineToolRow icon="✱" name="Grep" complete={true} pending="Searching content..." failed={props.failed}>
      "database" in packages/core (12 matches)
    </InlineToolRow>
  )
}

function ReminderAlignmentFixture() {
  return (
    <box flexDirection="column">
      <box paddingLeft={TRANSCRIPT_GUTTER}>
        <text>Switched variant to medium</text>
      </box>
      <InlineToolRow icon="◈" complete={true} pending="Notice">
        Instructions updated
      </InlineToolRow>
    </box>
  )
}

function TrailingStatusFixture() {
  return (
    <InlineToolRow icon=":" complete={true} pending="" status={<text flexShrink={0}> Background </text>}>
      Explore Subagent — Inspect renderer status styling
    </InlineToolRow>
  )
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup?.renderer.destroy()
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("TUI inline tool wrapping", () => {
  test("falls back for unknown tool names", () => {
    expect(toolDisplay("shell")).toBe("shell")
    expect(toolDisplay("subagent")).toBe("subagent")
    // Legacy tool names normalize to their renamed views.
    expect(toolDisplay("bash")).toBe("shell")
    expect(toolDisplay("task")).toBe("subagent")
    expect(toolDisplay("apply_patch")).toBe("patch")
    expect(toolDisplay("patch")).toBe("patch")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("replaces pending copy when a tool fails before completion", async () => {
    const frame = await renderFrame(() => <FailedPendingToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Patch failed")
    expect(frame).not.toContain("Preparing patch")
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Read src/index.ts")
    expect(frame).not.toContain("Read failed")
  })

  test("aligns switch reminders with instruction reminders", async () => {
    expect(await renderFrame(() => <ReminderAlignmentFixture />, { width: 35, height: 2 })).toBe(
      " Switched variant to medium\n ◈ Instructions updated",
    )
  })

  test("wraps a trailing status as one padded item", async () => {
    expect(await renderFrame(() => <TrailingStatusFixture />, { width: 70, height: 2 })).toBe(
      " : Explore Subagent — Inspect renderer status styling  Background",
    )
    expect(await renderFrame(() => <TrailingStatusFixture />, { width: 62, height: 2 })).toBe(
      " : Explore Subagent — Inspect renderer status styling\n    Background",
    )
  })

  test("leads a named row with the tool name, once, in both states", async () => {
    // The name is hoisted out of the row body so it can be painted in accent
    // while the arguments stay muted; the rendered line must still read as one
    // `Name args` phrase, with no doubled name and no missing separator.
    expect(await renderFrame(() => <NamedToolFixture />, { width: 60, height: 2 })).toBe(
      ' ✱ Grep "database" in packages/core (12 matches)',
    )
    const failed = await renderFrame(() => <NamedToolFixture failed={true} />, { width: 60, height: 2 })
    expect(failed).toBe(' ✱ Grep "database" in packages/core (12 matches)')
  })

  test("teases collapsed thinking with the tail of the trace", () => {
    // A short trace shows whole, flattened onto one line.
    expect(thinkingTeaser("  Checking\n\n  the   parser  ", 80)).toBe("Checking the parser")
    // A long one keeps its end, so the row shows what the model concluded.
    const long = "start " + "x".repeat(200) + " end"
    const teased = thinkingTeaser(long, 60)
    expect(teased.startsWith("...")).toBeTrue()
    expect(teased.endsWith("end")).toBeTrue()
    expect(teased.length).toBeLessThanOrEqual(60)
    // Never narrower than a usable tail, however cramped the terminal.
    expect(thinkingTeaser(long, 4).length).toBe(13)
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { file: "a.ts", patch: "diff", additions: 1, deletions: 0, status: "added" },
      ]),
    ).toEqual([
      {
        type: "add",
        relativePath: "a.ts",
        filePath: "a.ts",
        patch: "diff",
        additions: 1,
        deletions: 0,
        movePath: undefined,
      },
    ])
    expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])
    expect(parseQuestionAnswers([null, ["yes", 1], "no"])).toEqual([[], ["yes"], []])
    expect(parseQuestionAnswers({})).toBeUndefined()
  })

  test("summarizes execute calls on one line", () => {
    expect(
      executeCallSummary({
        tool: "session.prompt",
        status: "completed",
        input: { sessionID: "ses_example", notify: true },
      }),
    ).toBe("↳ session.prompt [sessionID=ses_example, notify=true]")
    expect(executeCallSummary({ tool: "session.get", status: "error", input: { nested: { hidden: true } } })).toBe(
      "↳ session.get (failed)",
    )
    expect(
      executeCallSummary({ tool: "session.prompt", status: "completed", input: { text: "first line\nsecond line" } }),
    ).toBe("↳ session.prompt [text=first line second line]")
  })

  test("summarizes generic tool arguments on one line", () => {
    // The tool name leads the row as an accented `name`, so the body is the
    // argument summary alone.
    const summary = (input: Record<string, unknown>) => primitiveInputSummary(input).replace(/\s+/g, " ")
    expect(
      summary({
        query: "wireless keyboard",
        limit: 8,
        includeArchived: false,
        filters: { category: "accessories" },
      }),
    ).toBe("[query=wireless keyboard, limit=8, includeArchived=false]")
    expect(summary({ city: "Tokyo", units: "celsius" })).toBe("[city=Tokyo, units=celsius]")
    expect(summary({})).toBe("")
  })

  test("ignores diagnostics with malformed nested ranges", () => {
    expect(
      parseDiagnostics(
        {
          "a.ts": [
            { severity: 1, message: "missing range" },
            { severity: 1, message: "bad line", range: { start: { line: "0", character: 1 } } },
            { severity: 1, message: "valid", range: { start: { line: 2, character: 3 } } },
          ],
        },
        "a.ts",
      ),
    ).toEqual([{ message: "valid", range: { start: { line: 2, character: 3 } } }])
  })

  test("labels only detached or async subagents as background", () => {
    expect(isBackgroundSubagent({ status: "running" }, "running")).toBeFalse()
    expect(isBackgroundSubagent({ status: "running" }, "completed")).toBeTrue()
    expect(isBackgroundSubagent({ status: "running" }, "error")).toBeFalse()
    expect(isBackgroundSubagent({ status: "completed" }, "completed")).toBeFalse()
  })

  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()
  })
})
