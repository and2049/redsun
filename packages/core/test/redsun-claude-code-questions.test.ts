import { describe, expect, it } from "bun:test"
import { ClaudeCodePermissions } from "@opencode-ai/core/plugin/redsun/claude-code/permissions"
import { ClaudeCodeQuestions } from "@opencode-ai/core/plugin/redsun/claude-code/questions"

const input = {
  questions: [
    {
      question: "Which database should the migration target?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "The production store" },
        { label: "SQLite", description: "Local only" },
      ],
    },
    {
      question: "Which suites should run first?",
      header: "Suites",
      multiSelect: true,
      options: [{ label: "unit" }, { label: "integration" }],
    },
  ],
}

describe("ClaudeCodeQuestions", () => {
  it("reads the questions out of a tool input", () => {
    const questions = ClaudeCodeQuestions.parse(input)
    expect(questions).toHaveLength(2)
    expect(questions?.[0]).toMatchObject({
      question: "Which database should the migration target?",
      header: "Database",
      multiSelect: false,
    })
  })

  it("rejects an input it cannot use", () => {
    expect(ClaudeCodeQuestions.parse({})).toBeUndefined()
    expect(ClaudeCodeQuestions.parse({ questions: [] })).toBeUndefined()
    expect(ClaudeCodeQuestions.parse({ questions: [{ header: "no question text" }] })).toBeUndefined()
  })

  it("falls back to the question text when no header is given", () => {
    const questions = ClaudeCodeQuestions.parse({ questions: [{ question: "Proceed?" }] })
    expect(questions?.[0]).toMatchObject({ header: "Proceed?", multiSelect: false, options: [] })
  })

  it("builds the same field shape the question tool builds", () => {
    const questions = ClaudeCodeQuestions.parse(input)!
    expect(ClaudeCodeQuestions.fields(questions)).toEqual([
      {
        key: "q0",
        title: "Database",
        description: "Which database should the migration target?",
        type: "string",
        options: [
          { value: "Postgres", label: "Postgres", description: "The production store" },
          { value: "SQLite", label: "SQLite", description: "Local only" },
        ],
        // The user must always be able to answer off-menu.
        custom: true,
      },
      {
        key: "q1",
        title: "Suites",
        description: "Which suites should run first?",
        type: "multiselect",
        options: [
          { value: "unit", label: "unit" },
          { value: "integration", label: "integration" },
        ],
        custom: true,
      },
    ])
  })

  it("keys answers by the full question text, as the SDK requires", () => {
    const questions = ClaudeCodeQuestions.parse(input)!
    expect(ClaudeCodeQuestions.answers(questions, { q0: "Postgres", q1: ["unit", "integration"] })).toEqual({
      "Which database should the migration target?": "Postgres",
      // Multi-select answers are comma-separated per the SDK's contract.
      "Which suites should run first?": "unit, integration",
    })
  })

  it("answers an unanswered question with an empty string rather than dropping it", () => {
    const questions = ClaudeCodeQuestions.parse(input)!
    expect(ClaudeCodeQuestions.answers(questions, { q0: "SQLite" })).toEqual({
      "Which database should the migration target?": "SQLite",
      "Which suites should run first?": "",
    })
  })
})

describe("ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT", () => {
  it("names the routed tool so a denied compose delegation is not a dead end", () => {
    expect(ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT).toContain("mcp__redsun__subagent")
  })

  it("still maps the native subagent tool onto the subagent permission", () => {
    // The redirect replaces the refusal text, not the gating: a non-compose
    // agent's subagent deny stays a plain deny.
    expect(
      ClaudeCodePermissions.mapPermission({
        toolName: "Agent",
        input: { subagent_type: "worker" },
        worktree: "/repo",
      }),
    ).toEqual({ action: "subagent", resource: "worker" })
    expect(
      ClaudeCodePermissions.mapPermission({ toolName: "Task", input: { subagent_type: "explore" }, worktree: "/repo" }),
    ).toEqual({ action: "subagent", resource: "explore" })
  })
})
