export * as ClaudeCodeNativeTools from "./native-tools.js"

import { FileDiff } from "@opencode/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"

// The edit renderer's `metadata.files` shape, as core's edit tool produces it.
const fileDiff = (
  file: string,
  before: string,
  after: string,
  status: typeof FileDiff.Info.Type.status = "modified",
): typeof FileDiff.Info.Type => {
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return { file, patch: createTwoFilesPatch(file, file, before, after), status, ...counts }
}

export const SUBAGENT_TOOLS = new Set(["Task", "Agent"])
export const HOST_TOOLS = new Set([
  "mcp__redsun__subagent",
  "mcp__redsun__skill",
  "mcp__redsun__todowrite",
  "mcp__redsun__worker_model",
  "mcp__redsun__execute",
])

const TOOL_NAMES: Record<string, string> = {
  Bash: "shell",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  NotebookEdit: "edit",
  Skill: "skill",
  AskUserQuestion: "question",
  TodoWrite: "todowrite",
  ExitPlanMode: "plan_exit",
  mcp__redsun__subagent: "subagent",
  mcp__redsun__skill: "skill",
  mcp__redsun__todowrite: "todowrite",
  mcp__redsun__worker_model: "worker_model",
  mcp__redsun__execute: "execute",
}

const INPUT_KEYS: Record<string, Record<string, string>> = {
  Read: { file_path: "path" },
  Edit: {
    file_path: "path",
    old_string: "oldString",
    new_string: "newString",
    replace_all: "replaceAll",
  },
  Write: { file_path: "path" },
  NotebookEdit: { notebook_path: "path" },
  Grep: { glob: "include" },
  Skill: { skill: "id" },
}

export const toolName = (name: string) => TOOL_NAMES[name] ?? name

const HOST_PREFIX = "mcp__redsun__"

/** Only a name selected into this turn's host bridge can be unwrapped to its canonical tool id. */
export const directHostToolName = (name: string, selected: (name: string) => boolean) =>
  name.startsWith(HOST_PREFIX) && selected(name) ? name.slice(HOST_PREFIX.length) : undefined

export const toolInput = (name: string, input: Record<string, unknown>): Record<string, unknown> => {
  const keys = INPUT_KEYS[name]
  if (!keys) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [keys[key] ?? key, value]))
}

type DiffFile = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** One of: an edit diff, question answers, a todo list, or a plan (`plan_exit`). */
export type Metadata = {
  files?: DiffFile[]
  answers?: string[][]
  todos?: Todo[]
  plan?: string
  filePath?: string
}

export const resultMetadata = (
  name: string,
  input: Record<string, unknown>,
  toolUseResult: unknown,
): Metadata | undefined => {
  if (name === "plan_exit") return planMetadata(input, record(toolUseResult))
  const result = record(toolUseResult)
  if (!result) return undefined
  if (name === "question") return questionAnswers(input, result)
  if (name === "todowrite") return todoMetadata(input, result)
  if (name !== "edit" && name !== "write") return undefined
  const path = typeof input.path === "string" ? input.path : undefined
  if (!path) return undefined
  if (typeof result.updated_file === "string") return notebookDiff(path, result)
  if (typeof result.filePath === "string" && result.filePath !== path) return undefined
  const original = typeof result.originalFile === "string" ? result.originalFile : undefined

  if (name === "write") {
    if (typeof result.content !== "string") return undefined
    const status = result.type === "create" || original === undefined ? "added" : "modified"
    return { files: [fileDiff(path, original ?? "", result.content, status)] }
  }

  if (original === undefined) return undefined
  const oldString = typeof result.oldString === "string" ? result.oldString : undefined
  const newString = typeof result.newString === "string" ? result.newString : undefined
  if (!oldString || newString === undefined) return undefined
  const replaced =
    result.replaceAll === true
      ? original.split(oldString).join(newString)
      : original.replace(oldString, () => newString)
  if (replaced === original) return undefined
  return { files: [fileDiff(path, original, replaced, "modified")] }
}

// `NotebookEditOutput` carries the whole notebook before and after, so the row
// diffs the file the way redsun's own edit of an `.ipynb` would.
const notebookDiff = (path: string, result: Record<string, unknown>) => {
  if (typeof result.notebook_path === "string" && result.notebook_path !== path) return undefined
  if (typeof result.error === "string" && result.error) return undefined
  const original = typeof result.original_file === "string" ? result.original_file : undefined
  const updated = result.updated_file as string
  if (original === undefined || original === updated) return undefined
  return { files: [fileDiff(path, original, updated, "modified")] }
}

// The plan lives in `ExitPlanModeOutput`, not the input; the approval outcome is
// merged in by translate from the host's per-tool-use record.
const planMetadata = (input: Record<string, unknown>, result: Record<string, unknown> | undefined) => {
  const plan = typeof result?.plan === "string" ? result.plan : typeof input.plan === "string" ? input.plan : undefined
  const filePath = typeof result?.filePath === "string" ? result.filePath : undefined
  if (plan === undefined && filePath === undefined) return undefined
  return { ...(plan === undefined ? {} : { plan }), ...(filePath === undefined ? {} : { filePath }) }
}

type Todo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }

const TODO_STATUSES = new Set<unknown>(["pending", "in_progress", "completed", "cancelled"])

// TodoWrite replaces the whole list, like redsun's `todowrite`; render-only, the
// host todo store is not written.
const todoMetadata = (input: Record<string, unknown>, result: Record<string, unknown>) => {
  const source = Array.isArray(result.newTodos) ? result.newTodos : input.todos
  if (!Array.isArray(source)) return undefined
  return {
    todos: source.flatMap((item): Todo[] => {
      const todo = record(item)
      if (typeof todo?.content !== "string" || !TODO_STATUSES.has(todo.status)) return []
      return [{ content: todo.content, status: todo.status as Todo["status"] }]
    }),
  }
}

const questionAnswers = (input: Record<string, unknown>, result: Record<string, unknown>) => {
  const answers = record(result.answers)
  if (!answers || !Array.isArray(input.questions)) return undefined
  return {
    answers: input.questions.map((question) => {
      const text = record(question)?.question
      const answer = typeof text === "string" ? answers[text] : undefined
      return typeof answer === "string" && answer ? [answer] : []
    }),
  }
}
