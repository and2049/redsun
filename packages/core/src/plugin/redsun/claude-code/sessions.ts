export * as ClaudeCodeSessions from "./sessions.js"

import type { Options, PermissionMode, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  close(): void
  initializationResult?(): Promise<unknown>
  accountInfo?(): Promise<unknown>
}

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
          const turn = session.turn
          if (session.observer) {
            try {
              await session.observer(message, turn !== undefined)
            } catch {}
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
    const bypassing = input.permissionMode === "bypassPermissions"
    if (session && bypassing !== session.bypassAllowed) {
      this.stop(sessionID)
      session = undefined
    }
    if (!session) session = this.start(sessionID, input)
    else {
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
    } catch {}
  }

  stopAll(): void {
    for (const sessionID of [...this.sessions.keys()]) this.stop(sessionID)
  }
}
