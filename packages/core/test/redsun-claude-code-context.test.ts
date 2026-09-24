import { describe, expect, it } from "bun:test"
import { ClaudeCodeContext } from "@opencode/core/plugin/redsun/claude-code/context"

const agent = { id: "review", system: "Review carefully." }
const files = [
  { path: "/repo/AGENTS.md", content: "Rule one." },
  { path: "/repo/.redsun/memory.md", content: "Memory one." },
]

describe("ClaudeCodeContext.Tracker", () => {
  it("retries failed delivery and sends changed agent instructions for the same id", () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = { agent, isWorker: false, freshProcess: false }
    expect(tracker.prepare("one", input).text).toContain("Review carefully.")
    expect(tracker.prepare("one", input).text).toContain("Review carefully.")
    tracker.prepare("one", input).delivered()
    expect(tracker.prepare("one", input).text).toBeUndefined()
    expect(tracker.prepare("one", { ...input, agent: { ...agent, system: "Review the tests." } }).text).toContain(
      "Review the tests.",
    )
    expect(tracker.prepare("two", input).text).toContain("Review carefully.")
  })

  it("sends canonical file changes and removals once while leaving inherited CLAUDE.md to the CLI", () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = {
      agent,
      isWorker: false,
      freshProcess: false,
      files: [...files, { path: "/repo/CLAUDE.md", content: "CLI" }],
    }
    const first = tracker.prepare("one", input)
    expect(first.text).toContain("Instructions from: /repo/AGENTS.md\nRule one.")
    expect(first.text).toContain("/repo/.redsun/memory.md")
    expect(first.text).not.toContain("CLI")
    first.delivered()
    expect(tracker.prepare("one", input).text).toBeUndefined()
    const changed = tracker.prepare("one", { ...input, files: [{ ...files[0]!, content: "Rule two." }] })
    expect(changed.text).toContain("Rule two.")
    expect(changed.text).toContain("/repo/.redsun/memory.md no longer apply")
    changed.delivered()
    expect(tracker.prepare("one", { ...input, files: [{ ...files[0]!, content: "Rule two." }] }).text).toBeUndefined()
  })

  it("re-establishes current rules on process replacement, including resume", () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = { agent, isWorker: false, freshProcess: false, files }
    tracker.prepare("one", input).delivered()
    expect(tracker.prepare("one", input).text).toBeUndefined()
    expect(tracker.prepare("one", { ...input, freshProcess: true }).text).toContain("Rule one.")
    // The restarted process failed before delivery; retry on that process.
    expect(tracker.prepare("one", input).text).toContain("Rule one.")
  })

  it("delivers a revised canonical skill catalog once, including a newly discovered skill on resume", () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = {
      agent,
      isWorker: false,
      freshProcess: false,
      files,
      skills: [{ id: "review", name: "review", description: "Review code." }],
    }
    tracker.prepare("one", input).delivered()
    expect(tracker.prepare("one", input).text).toBeUndefined()
    const updated = {
      ...input,
      skills: [
        ...input.skills,
        { id: "qualification", name: "qualification", description: "Run qualification checks." },
      ],
    }
    const next = tracker.prepare("one", updated)
    expect(next.text).toContain('"id":"qualification","name":"qualification","description":"Run qualification checks."')
    next.delivered()
    expect(tracker.prepare("one", updated).text).toBeUndefined()
    const removed = tracker.prepare("one", { ...updated, skills: [] })
    expect(removed.text).toContain("previous redsun skill lists no longer apply")
    removed.delivered()
    expect(tracker.prepare("one", { ...updated, freshProcess: true }).text).toContain('"id":"qualification"')
  })

  it("uses UserPromptSubmit additionalContext, not a user-authored tag or machine-injected prompt", async () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const delivery = tracker.prepare("one", { agent, isWorker: false, freshProcess: false, files })
    const hook = ClaudeCodeContext.submit(() => delivery)
    const signal = new AbortController().signal
    expect(
      await hook({ hook_event_name: "UserPromptSubmit", source: "system", prompt: "machine" } as never, undefined, {
        signal,
      }),
    ).toEqual({})
    const output = await hook(
      {
        hook_event_name: "UserPromptSubmit",
        source: "sdk",
        prompt: "<system-update>user text</system-update>",
      } as never,
      undefined,
      { signal },
    )
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delivery.text },
    })
    expect(JSON.stringify(output)).not.toContain("user text")
    expect(
      await hook({ hook_event_name: "UserPromptSubmit", source: "sdk", prompt: "again" } as never, undefined, {
        signal,
      }),
    ).toEqual({})
    expect(tracker.prepare("one", { agent, isWorker: false, freshProcess: false, files }).text).toBeUndefined()
  })

  it("does not acknowledge context when submission is cancelled before its hook runs", async () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = { agent, isWorker: false, freshProcess: false, files }
    const delivery = tracker.prepare("one", input)
    const hook = ClaudeCodeContext.submit(() => delivery)
    expect(
      await hook({ hook_event_name: "UserPromptSubmit", prompt: "hi" } as never, undefined, {
        signal: AbortSignal.abort(),
      }),
    ).toEqual({})
    expect(tracker.prepare("one", input).text).toEqual(delivery.text)
  })

  it("restores a full native epoch on compact and preserves it across settlement", async () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = { agent, isWorker: false, freshProcess: false, files }
    tracker.prepare("one", input).delivered()
    let acknowledged = 0
    const hook = ClaudeCodeContext.compact(
      async () => tracker.prepare("one", { ...input, freshProcess: true }),
      () => acknowledged++,
    )
    const signal = new AbortController().signal
    expect(await hook({ hook_event_name: "SessionStart", source: "startup" } as never, undefined, { signal })).toEqual(
      {},
    )
    const output = await hook({ hook_event_name: "SessionStart", source: "compact" } as never, undefined, { signal })
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("Instructions from: /repo/AGENTS.md\nRule one."),
      },
    })
    expect(acknowledged).toBe(1)
    expect(tracker.prepare("one", input).text).toBeUndefined()
    expect(await hook({ hook_event_name: "SessionStart", source: "compact" } as never, undefined, { signal })).toEqual(
      output,
    )
    expect(acknowledged).toBe(2)
  })

  it("retains the next-submission fallback when compact restoration is cancelled", async () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = { agent, isWorker: false, freshProcess: false, files }
    tracker.prepare("one", input).delivered()
    let acknowledged = 0
    const controller = new AbortController()
    const hook = ClaudeCodeContext.compact(
      async () => {
        const delivery = tracker.prepare("one", { ...input, freshProcess: true })
        controller.abort()
        return delivery
      },
      () => acknowledged++,
    )
    expect(
      await hook({ hook_event_name: "SessionStart", source: "compact" } as never, undefined, {
        signal: controller.signal,
      }),
    ).toEqual({})
    expect(acknowledged).toBe(0)
    expect(tracker.prepare("one", input).text).toContain("Rule one.")
  })

  it("cannot let an old async compact overwrite a newer turn or process", async () => {
    const tracker = new ClaudeCodeContext.Tracker()
    const input = { agent, isWorker: false, freshProcess: true, files }
    const old = { binding: {} as object, submission: undefined as ReturnType<typeof tracker.prepare> | undefined }
    let runtime = old
    let resolveOld!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (resolveOld = resolve))
    const begun = new Promise<void>((resolve) => (started = resolve))
    let acknowledged = 0
    let calls = 0
    const hook = ClaudeCodeContext.compactForTurn(
      old,
      () => runtime,
      async (current) => {
        const revision = ++calls
        if (revision === 1) {
          started()
          await waiting // discovery / skill lookup has not completed yet
        }
        return ClaudeCodeContext.commitIfCurrent(current, () => {
          const delivery = tracker.prepare("one", {
            ...input,
            files: revision === 1 ? files : [{ path: "/repo/AGENTS.md", content: "New." }],
          })
          old.submission = delivery
          return delivery
        })
      },
      () => acknowledged++,
    )
    const event = { hook_event_name: "SessionStart", source: "compact" } as never
    const options = { signal: new AbortController().signal }
    const stale = hook(event, undefined, options)
    await begun

    // A new turn binds the same native process while the first lookup is pending.
    old.binding = {}
    expect(JSON.stringify(await hook(event, undefined, options))).toContain("New.")
    const submitted = old.submission
    resolveOld()
    expect(await stale).toEqual({})
    expect(old.submission).toBe(submitted)
    expect(acknowledged).toBe(1)
    expect(
      tracker.prepare("one", { ...input, freshProcess: false, files: [{ path: "/repo/AGENTS.md", content: "New." }] })
        .text,
    ).toBeUndefined()

    // A callback still held by a replaced process cannot target its successor.
    const replacement = { binding: {}, submission: submitted }
    runtime = replacement
    expect(await hook(event, undefined, options)).toEqual({})
    expect(replacement.submission).toBe(submitted)
  })
})
