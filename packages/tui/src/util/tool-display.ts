export function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  // Claude Code's delegated task-list tool renders through the same checklist row.
  if (name === "TodoWrite") return "todowrite"
  return name
}

export type TodoItem = { content: string; status: string; children: TodoItem[] }

export function todoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TodoItem[] => {
    if (typeof item !== "object" || item === null) return []
    const { content, status, children } = item as Record<string, unknown>
    if (typeof content !== "string" || typeof status !== "string") return []
    return [{ content, status, children: todoItems(children) }]
  })
}

export function flattenTodos(todos: ReadonlyArray<TodoItem>): TodoItem[] {
  return todos.flatMap((todo) => [todo, ...flattenTodos(todo.children)])
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

export function primitiveInputSummary(input: Record<string, unknown>, omit: readonly string[] = []) {
  const entries = Object.entries(input).filter(([key, value]) => {
    if (omit.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

export function webSearchProviderLabel(provider: unknown) {
  if (typeof provider !== "string" || !provider) return "Web Search"
  return `Web Search via ${provider[0].toUpperCase()}${provider.slice(1)}`
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "streaming") return {}
  if (!("metadata" in state) || !state.metadata || typeof state.metadata !== "object") return {}
  if (Array.isArray(state.metadata)) return {}
  return state.metadata as Record<string, unknown>
}

export function toolDisplayContent(state: SessionMessageAssistantTool["state"]) {
  if (state.status === "streaming" || state.status === "running") return []
  return state.content ?? []
}

export function nonEmptyToolContent<T>(content: ReadonlyArray<T> | undefined): [T, ...T[]] | undefined {
  if (!content) return undefined
  const [first, ...rest] = content
  return first === undefined ? undefined : [first, ...rest]
}
import type { SessionMessageAssistantTool } from "@opencode-ai/client/promise"
