export * as ClaudeCodeSessions from "./sessions.js"

import type { Options, PermissionMode, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  close(): void
  initializationResult?(): Promise<unknown>
  accountInfo?(): Promise<unknown>
  supportedModels?(): Promise<unknown>
}

export type CreateQuery = (input: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike

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
          return this.failure
            ? Promise.reject(this.failure)
            : Promise.resolve({ value: undefined as never, done: true })
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

/** See ClaudeCodeSubagents.Continuation: what the CLI still owes after a result. */
export type HoldReason = "active" | "children" | "queued" | "none"

export interface SessionOptions {
  readonly model: string
  readonly permissionMode: PermissionMode
  readonly observer?: (message: SDKMessage, inTurn: boolean) => Promise<void> | void
  /**
   * Consulted when a successful result lands and again on every later frame
   * while the turn is held. "children" and "queued" withhold the result: the
   * CLI will open a continuation turn by itself once its background agents
   * report, and that turn's frames belong to this host turn rather than to
   * nothing. A "queued" hold is bounded, "children" waits for the agents.
   */
  readonly holdTurn?: () => HoldReason
  readonly onExit?: () => Promise<void> | void
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
  /** The withheld result of the current turn, pushed when the hold releases without a newer one. */
  held?: { turn: AsyncQueue<SDKMessage>; result: SDKMessage; watchdog?: ReturnType<typeof setTimeout> }
  interrupted: boolean
  observer?: SessionOptions["observer"]
  holdTurn?: SessionOptions["holdTurn"]
  onExit?: SessionOptions["onExit"]
  exited: boolean
  dead: boolean
  pump: Promise<void>
}

const MAX_LIVE_SESSIONS = 4
const INTERRUPT_GRACE_MS = 15_000
// The CLI announces a queued continuation turn (system init) as soon as the
// previous result goes out, so a hold that only waits for that announcement
// needs seconds, not the minutes an agent may run.
const CONTINUATION_GRACE_MS = 15_000

export class SessionManager {
  private sessions = new Map<string, LiveSession>()
  private interruptGraceMs: number
  private continuationGraceMs: number
  private onStart?: (query: QueryLike) => void

  constructor(
    private createQuery: CreateQuery,
    options?: { interruptGraceMs?: number; continuationGraceMs?: number; onStart?: (query: QueryLike) => void },
  ) {
    this.interruptGraceMs = options?.interruptGraceMs ?? INTERRUPT_GRACE_MS
    this.continuationGraceMs = options?.continuationGraceMs ?? CONTINUATION_GRACE_MS
    this.onStart = options?.onStart
  }

  /** Ends the turn. A withheld result stands in when no newer one arrived. */
  private end(session: LiveSession, turn: AsyncQueue<SDKMessage>, result?: SDKMessage) {
    const held = session.held?.turn === turn ? session.held : undefined
    if (held) {
      clearTimeout(held.watchdog)
      session.held = undefined
    }
    const final = result ?? held?.result
    if (final) turn.push(final)
    turn.end()
    if (session.turn === turn) session.turn = undefined
  }

  private clearHold(session: LiveSession) {
    if (!session.held) return
    clearTimeout(session.held.watchdog)
    session.held = undefined
  }

  // Re-read what the CLI still owes. Waiting for agents is open-ended; waiting
  // for the turn a delivered notification queues is bounded, because a CLI
  // that folded the notification into the finished turn never opens one.
  private rearm(session: LiveSession, turn: AsyncQueue<SDKMessage>) {
    const held = session.held
    if (!held || held.turn !== turn) return
    clearTimeout(held.watchdog)
    held.watchdog = undefined
    const reason = session.holdTurn?.() ?? "none"
    if (reason === "none") return this.end(session, turn)
    if (reason !== "queued") return
    held.watchdog = setTimeout(() => {
      if (session.held === held && session.turn === turn && !session.dead) this.end(session, turn)
    }, this.continuationGraceMs)
    held.watchdog.unref?.()
  }

  private async exit(session: LiveSession) {
    if (session.exited) return
    session.exited = true
    try {
      await session.onExit?.()
    } catch {}
  }

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
      interrupted: false,
      observer: input.observer,
      holdTurn: input.holdTurn,
      onExit: input.onExit,
      exited: false,
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
          if (!turn) continue
          if (message.type === "result") {
            const reason =
              message.subtype === "success" && !session.interrupted ? (session.holdTurn?.() ?? "none") : "none"
            if (reason === "children" || reason === "queued") {
              this.clearHold(session)
              session.held = { turn, result: message }
              this.rearm(session, turn)
              continue
            }
            this.end(session, turn, message)
            continue
          }
          turn.push(message)
          if (session.held?.turn === turn) this.rearm(session, turn)
        }
        session.dead = true
        this.clearHold(session)
        session.turn?.fail(new Error("Claude Code process exited before the turn completed"))
        session.turn = undefined
        await this.exit(session)
      } catch (error) {
        session.dead = true
        this.clearHold(session)
        session.turn?.fail(error)
        session.turn = undefined
        await this.exit(session)
      }
    })()
    this.sessions.set(sessionID, session)
    this.evict(sessionID)
    try {
      this.onStart?.(query)
    } catch {}
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

  /** Startup-only options, including the system preset, are reapplied on a new process. */
  willStart(sessionID: string, permissionMode: PermissionMode): boolean {
    const session = this.sessions.get(sessionID)
    return !session || session.dead || (permissionMode === "bypassPermissions") !== session.bypassAllowed
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
      session.holdTurn = input.holdTurn
      session.onExit = input.onExit
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
    session.interrupted = false
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
    const turn = session.turn
    // Never re-hold after an interrupt: the CLI kills background tasks, and
    // their stop notifications must not keep the host turn waiting.
    session.interrupted = true
    try {
      await session.query.interrupt()
    } catch {
      this.stop(sessionID)
      return
    }
    if (turn === undefined || session.turn !== turn) return
    // A held turn whose CLI side is idle gets no result frame for the
    // interrupt; release it with the result it already produced.
    if (session.held?.turn === turn && session.holdTurn?.() !== "active") {
      this.end(session, turn)
      return
    }
    // The CLI acknowledges an interrupt by ending the turn with a result frame.
    // If that never arrives the turn queue stays open and busy() is true until
    // process death — bound it by killing the process after a grace period.
    const timer = setTimeout(() => {
      if (!session.dead && session.turn === turn && this.sessions.get(sessionID) === session) this.stop(sessionID)
    }, this.interruptGraceMs)
    timer.unref?.()
  }

  stop(sessionID: string): void {
    const session = this.sessions.get(sessionID)
    if (!session) return
    this.sessions.delete(sessionID)
    session.dead = true
    this.clearHold(session)
    session.prompt.end()
    session.turn?.fail(new Error("Claude Code session was closed"))
    session.turn = undefined
    try {
      session.query.close()
    } catch {}
    void this.exit(session)
  }

  stopAll(): void {
    for (const sessionID of [...this.sessions.keys()]) this.stop(sessionID)
  }
}
