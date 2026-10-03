import { expect, test } from "bun:test"
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeContext as Context } from "@redsun/runtime-claude-code/context"

const event: HookInput = {
  hook_event_name: "UserPromptSubmit",
  session_id: "native",
  cwd: "/repo",
  transcript_path: "/transcript",
  prompt: "Hello",
}
const invoke = (hooks: HookCallback[], signal = new AbortController().signal, input: HookInput = event) =>
  Promise.all(hooks.map((hook) => hook(input, undefined, { signal })))
const text = (results: Awaited<ReturnType<typeof invoke>>) =>
  results.map((result) => {
    const output = "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined
    return output && "additionalContext" in output ? (output.additionalContext ?? "") : ""
  })

test("large host context is delivered intact in bounded chunks and acknowledged once", async () => {
  let acknowledged = 0
  const content = "x".repeat(Context.CHUNK_SIZE - 1) + "🌲" + "y".repeat(30_000) + "TAIL_MARKER"
  const delivery = { text: content, delivered: () => acknowledged++ }
  const hooks = Context.partition((commit) => Context.submit(() => delivery, commit))
  const parts = text(await invoke(hooks))
  expect(parts.join("")).toBe(content)
  expect(parts.every((part) => part.length < 10_000 && part.isWellFormed())).toBe(true)
  expect(acknowledged).toBe(1)
  expect(text(await invoke(hooks)).join("")).toBe("")
  expect(acknowledged).toBe(1)
})

test("partial or cancelled hook banks are not acknowledged and can retry", async () => {
  let acknowledged = 0
  const delivery = { text: "x".repeat(20_000), delivered: () => acknowledged++ }
  const hooks = Context.partition((commit) => Context.submit(() => delivery, commit))
  const controller = new AbortController()
  await hooks[0]!(event, undefined, { signal: controller.signal })
  expect(acknowledged).toBe(0)
  controller.abort()
  await invoke(hooks.slice(1), controller.signal)
  expect(acknowledged).toBe(0)
  expect(text(await invoke(hooks)).join("")).toBe(delivery.text)
  expect(acknowledged).toBe(1)
})

test("over-capacity context stops continuation instead of claiming a truncated delivery", async () => {
  let acknowledged = 0
  const delivery = { text: "x".repeat(Context.CHUNK_SIZE * Context.CHUNK_COUNT + 1), delivered: () => acknowledged++ }
  const hooks = Context.partition((commit) => Context.submit(() => delivery, commit))
  const results = await invoke(hooks)
  expect(results.every((result) => "continue" in result && result.continue === false)).toBe(true)
  expect(acknowledged).toBe(0)
})

test("a delayed superseded compaction cannot commit into the next hook bank", async () => {
  let finish!: (value: { text: string; delivered: () => void }) => void
  let reads = 0
  let old = 0
  let fresh = 0
  let restored = 0
  const hooks = Context.partition((commit) =>
    Context.compact(
      () =>
        ++reads === 1
          ? new Promise((resolve) => (finish = resolve))
          : Promise.resolve({ text: "NEW", delivered: () => fresh++ }),
      () => restored++,
      () => true,
      commit,
    ),
  )
  const compact: HookInput = {
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "native",
    cwd: "/repo",
    transcript_path: "/transcript",
  }
  const stale = invoke(hooks, undefined, compact)
  expect(text(await invoke(hooks, undefined, compact)).join("")).toBe("NEW")
  finish({ text: "OLD", delivered: () => old++ })
  expect(text(await stale).join("")).toBe("")
  expect({ old, fresh, restored }).toEqual({ old: 0, fresh: 1, restored: 1 })
})
