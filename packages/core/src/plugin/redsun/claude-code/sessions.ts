// REDSUN: persistent Claude Code session processes.
//
// Ported from V1 unchanged apart from the v2 self-export convention. Kept
// Effect-free on purpose: the Agent SDK boundary is promises and async
// iterables, and the Effect seam lives in the language model.
export * as ClaudeCodeSessions from "./sessions.js"

import type { Options, PermissionMode, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

/**
 * Plain-TS manager for persistent Claude Code sessions. One live `query()`
 * process per redsun session, fed through a streaming prompt queue; each
 * redsun turn is a bounded window over the process's message stream that ends
 * at the turn's `result` message.
 *
 * Kept Effect-free on purpose: the Agent SDK boundary is promises and async
 * iterables, and the Effect seam lives in runtime.ts.
 */

export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  close(): void
  /** Init handshake (account/commands/models); used by the auth probe. */
  initializationResult?(): Promise<unknown>
}

/** Injectable so tests can run against fixture message streams. */
export type CreateQuery = (input: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options: Options
}) => QueryLike

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: ((result: IteratorResult<T>) => void)[] = []
  private done = false
  private failure: unknown

  push(value: T) {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end() {
    if (this.done) return
    this.done = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  fail(error: unknown) {
    if (this.done) return
    this.failure = error ?? new Error("claude code session ended unexpectedly")
    this.end()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false })
        if (this.done)
          return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve, reject) => {
          this.waiters.push((result) => {
            if (result.done && this.failure) reject(this.failure)
            else resolve(result)
          })
        })
      },
    }
  }
}

export interface SessionOptions {
  readonly model: string
  readonly permissionMode: PermissionMode
  /**
   * Called for every SDK message the process emits, in stream order, before
   * the message is (maybe) delivered to the turn queue. `inTurn` is false for
   * frames that arrive between turn windows — async-launched subagent
   * activity, task notifications, and main-thread auto-continuations — which
   * the turn queue would otherwise drop on the floor. The callback persists
   * across turns (each turn() call replaces it) and is awaited so downstream
   * turn consumers always observe its effects; failures are swallowed.
   */
  readonly observer?: (message: SDKMessage, inTurn: boolean) => Promise<void> | void
  readonly options: Omit<
    Options,
    "model" | "permissionMode" | "allowDangerouslySkipPermissions" | "includePartialMessages" | "forwardSubagentText"
  >
}

interface LiveSession {
  query: QueryLike
  model: string
  permissionMode: PermissionMode
  /** Whether the process was spawned with `allowDangerouslySkipPermissions`. */
  bypassAllowed: boolean
  prompt: AsyncQueue<SDKUserMessage>
  turn?: AsyncQueue<SDKMessage>
  observer?: SessionOptions["observer"]
  dead: boolean
  pump: Promise<void>
}

const MAX_LIVE_SESSIONS = 4

export class SessionManager {
  private sessions = new Map<string, LiveSession>()

  constructor(private createQuery: CreateQuery) {}

  private start(sessionID: string, input: SessionOptions): LiveSession {
    const prompt = new AsyncQueue<SDKUserMessage>()
    const query = this.createQuery({
      prompt,
      options: {
        ...input.options,
        model: input.model,
        permissionMode: input.permissionMode,
        ...(input.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        // Full subagent conversations (text/thinking, not just tool frames)
        // so subagents.ts can mirror them into redsun child sessions.
        forwardSubagentText: true,
      },
    })
    const session: LiveSession = {
      query,
      model: input.model,
      permissionMode: input.permissionMode,
      bypassAllowed: input.permissionMode === "bypassPermissions",
      prompt,
      observer: input.observer,
      dead: false,
      pump: Promise.resolve(),
    }
    session.pump = (async () => {
      try {
        for await (const message of query) {
          // Snapshot the turn before the (async) observer runs so a turn that
          // starts mid-await cannot receive frames that predate its prompt.
          const turn = session.turn
          if (session.observer) {
            try {
              await session.observer(message, turn !== undefined)
            } catch {
              // Observer failures must never stall or kill the pump.
            }
          }
          turn?.push(message)
          if (message.type === "result") {
            turn?.end()
            if (session.turn === turn) session.turn = undefined
          }
        }
        session.dead = true
        session.turn?.fail(new Error("Claude Code process exited before the turn completed"))
        session.turn = undefined
      } catch (error) {
        session.dead = true
        session.turn?.fail(error)
        session.turn = undefined
      }
    })()
    this.sessions.set(sessionID, session)
    this.evict(sessionID)
    return session
  }

  private evict(keep: string) {
    while (this.sessions.size > MAX_LIVE_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined || oldest === keep) return
      this.stop(oldest)
    }
  }

  busy(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.turn !== undefined
  }

  /**
   * Run one turn: deliver the prompt to the session's live process (creating
   * or re-creating it as needed) and return a bounded stream of SDK messages
   * ending at the turn's `result`.
   */
  async turn(
    sessionID: string,
    prompt: SDKUserMessage["message"]["content"],
    input: SessionOptions,
  ): Promise<AsyncIterable<SDKMessage>> {
    let session = this.sessions.get(sessionID)
    if (session?.dead) {
      this.sessions.delete(sessionID)
      session = undefined
    }
    if (session?.turn) throw new Error("Claude Code session is already processing a turn")
    // `allowDangerouslySkipPermissions` is a spawn-time flag, so a live process
    // that was not started with it can never be raised to bypassPermissions by
    // control request. Restart instead; `input.options.resume` carries the
    // conversation across.
    if (session && input.permissionMode === "bypassPermissions" && !session.bypassAllowed) {
      this.stop(sessionID)
      session = undefined
    }
    if (!session) session = this.start(sessionID, input)
    else {
      // Refresh LRU position.
      this.sessions.delete(sessionID)
      this.sessions.set(sessionID, session)
      session.observer = input.observer
      if (session.model !== input.model) {
        await session.query.setModel(input.model)
        session.model = input.model
      }
      if (session.permissionMode !== input.permissionMode) {
        await session.query.setPermissionMode(input.permissionMode)
        session.permissionMode = input.permissionMode
      }
    }

    const turn = new AsyncQueue<SDKMessage>()
    session.turn = turn
    session.prompt.push({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    })
    return turn
  }

  async interrupt(sessionID: string): Promise<void> {
    const session = this.sessions.get(sessionID)
    if (!session || session.dead) return
    await session.query.interrupt()
  }

  stop(sessionID: string): void {
    const session = this.sessions.get(sessionID)
    if (!session) return
    this.sessions.delete(sessionID)
    session.dead = true
    session.prompt.end()
    session.turn?.fail(new Error("Claude Code session was closed"))
    session.turn = undefined
    try {
      session.query.close()
    } catch {
      // process already gone
    }
  }

  stopAll(): void {
    for (const sessionID of [...this.sessions.keys()]) this.stop(sessionID)
  }
}
