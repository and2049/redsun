export * as AcpRuntime from "./runtime.js"

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { DelegatedPermissionCheck, DelegatedStreamResult, DelegatedTurn } from "@opencode/plugin/effect/delegate"
import type { AcpOptions } from "./options.js"
import { AcpPermissions } from "./permissions.js"
import { AcpTranslate } from "./translate.js"

/** What the runtime needs from the host, as plain async calls (the plugin binds them to `ctx`). */
export interface Host {
  readonly cwd: string
  readonly mode: () => Promise<"normal" | "auto" | "native_auto">
  /** Asks the host policy (prompting when it asks); resolves false on decline. */
  readonly approve: (check: DelegatedPermissionCheck) => Promise<boolean>
}

export interface Process {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly kill: () => void
  readonly exited: Promise<unknown>
}

export type Spawn = (agent: AcpOptions.Agent, cwd: string) => Process

export const spawnProcess: Spawn = (agent, cwd) => {
  const child = spawn(agent.command, [...agent.args], {
    cwd,
    env: { ...process.env, ...agent.env },
    stdio: ["pipe", "pipe", "ignore"],
  })
  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    kill: () => void child.kill(),
    exited: new Promise((resolve) => {
      child.once("exit", resolve)
      child.once("error", resolve)
    }),
  }
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
          .join("\n")
      : ""

/** What the agent has not seen: the user messages after its last reply (it keeps its own history). */
export const promptDelta = (prompt: LanguageModelV3Prompt) => {
  const last = prompt.findLastIndex((message) => message.role === "assistant")
  const fresh = prompt.slice(last + 1).filter((message) => message.role === "user")
  const joined = fresh
    .map((message) => text(message.content))
    .filter(Boolean)
    .join("\n\n")
  if (joined) return joined
  return text(prompt.findLast((message) => message.role === "user")?.content)
}

/** A one-shot request (title, generate) carries its whole question in the transcript. */
export const flatten = (prompt: LanguageModelV3Prompt) =>
  prompt
    .map((message) => {
      const line = message.role === "system" ? String(message.content) : text(message.content)
      return line ? `${message.role}: ${line}` : ""
    })
    .filter(Boolean)
    .join("\n\n")

interface Session {
  readonly sessionID: string
  exited: boolean
  readonly process: Process
  readonly connection: ClientSideConnection
  readonly acpSessionID: string
  readonly modes: ReadonlySet<string>
  readonly initialMode?: string
  currentMode?: string
  agent?: string
  listener?: (update: SessionUpdate) => void
}

export class Runtime {
  private readonly sessions = new Map<string, Session>()
  /** Every open agent process, including one-shot ones. */
  private readonly live = new Set<Session>()

  constructor(
    private readonly agent: AcpOptions.Agent,
    private readonly host: Host,
    private readonly spawn: Spawn = spawnProcess,
  ) {}

  /**
   * Callbacks for one agent process. ACP session ids are only unique per connection (a one-shot
   * process may reuse the live session's id), so updates route to the process's own session.
   */
  private client(current: () => Session | undefined): Client {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        const session = current()
        if (!session || notification.sessionId !== session.acpSessionID) return
        if (notification.update.sessionUpdate === "current_mode_update")
          session.currentMode = notification.update.currentModeId
        session.listener?.(notification.update)
      },
      requestPermission: async (request) => {
        const session = current()
        if (!session || request.sessionId !== session.acpSessionID) return { outcome: { outcome: "cancelled" } }
        const check = AcpPermissions.check(request, { sessionID: session.sessionID, agent: session.agent })
        return AcpPermissions.respond(request, await this.host.approve(check).catch(() => false))
      },
    }
  }

  private async open(sessionID: string): Promise<Session> {
    const process = this.spawn(this.agent, this.host.cwd)
    let opened: Session | undefined
    const connection = new ClientSideConnection(
      () => this.client(() => opened),
      ndJsonStream(process.stdin, process.stdout),
    )
    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // The agent keeps its own file and terminal tools (decision D6 is still open).
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const created = await connection.newSession({ cwd: this.host.cwd, mcpServers: [] })
      const session: Session = {
        sessionID,
        exited: false,
        process,
        connection,
        acpSessionID: created.sessionId,
        modes: new Set(created.modes?.availableModes.map((mode) => mode.id) ?? []),
        ...(created.modes
          ? { initialMode: created.modes.currentModeId, currentMode: created.modes.currentModeId }
          : {}),
      }
      opened = session
      this.live.add(session)
      void process.exited.then(() => {
        session.exited = true
        this.forget(session)
      })
      return session
    } catch (error) {
      process.kill()
      throw new Error(
        `${this.agent.name} did not start an ACP session: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private forget(session: Session) {
    this.live.delete(session)
    if (this.sessions.get(session.sessionID) === session) this.sessions.delete(session.sessionID)
  }

  private close(session: Session) {
    this.forget(session)
    session.process.kill()
  }

  /**
   * A failure as this agent's own error. Connection errors carry network-style codes (EPIPE when the
   * process is gone) that the host would otherwise report as a bare transport failure.
   */
  private failure(session: Session, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return new Error(
      session.exited
        ? `${this.agent.name} exited during the turn${detail ? ` (${detail})` : ""}.`
        : `${this.agent.name} failed: ${detail || "unknown error"}`,
    )
  }

  /** The agent's own approval mode follows the host's native_auto selection. */
  private async applyMode(session: Session) {
    const selected = this.agent.nativeApprovalMode && (await this.host.mode()) === "native_auto"
    const wanted = selected ? this.agent.nativeApprovalMode : (this.agent.defaultMode ?? session.initialMode)
    if (!wanted || wanted === session.currentMode || !session.modes.has(wanted)) return
    await session.connection.setSessionMode({ sessionId: session.acpSessionID, modeId: wanted })
    session.currentMode = wanted
  }

  async turn(turn: DelegatedTurn, options: LanguageModelV3CallOptions): Promise<DelegatedStreamResult> {
    const oneShot = turn.kind !== "primary"
    const prompt = oneShot ? flatten(options.prompt) : promptDelta(options.prompt)
    if (!prompt) throw new Error(`No user prompt to deliver to ${this.agent.name}.`)
    const existing = oneShot ? undefined : this.sessions.get(turn.sessionID)
    if (existing?.listener) throw new Error(`${this.agent.name} session is already processing a turn.`)
    const session = existing ?? (await this.open(turn.sessionID))
    if (!oneShot) this.sessions.set(turn.sessionID, session)
    session.agent = turn.agent
    if (!oneShot) await this.applyMode(session)

    const state = AcpTranslate.make()
    const cancel = () => void session.connection.cancel({ sessionId: session.acpSessionID }).catch(() => {})
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start: async (controller) => {
          let closed = false
          const emit = (parts: readonly LanguageModelV3StreamPart[]) => {
            for (const part of parts) {
              if (closed) return
              try {
                controller.enqueue(part)
              } catch {
                closed = true
              }
            }
          }
          emit([{ type: "stream-start", warnings: [] }])
          session.listener = (update) => emit(AcpTranslate.update(state, update))
          options.abortSignal?.addEventListener("abort", cancel, { once: true })
          if (options.abortSignal?.aborted) cancel()
          try {
            const response = await session.connection.prompt({
              sessionId: session.acpSessionID,
              prompt: [{ type: "text", text: prompt }],
            })
            emit(AcpTranslate.finish(state, response.stopReason))
          } catch (error) {
            // Let an exit notification land first so the message can say the process is gone.
            await Promise.race([session.process.exited, new Promise((resolve) => setTimeout(resolve, 50))])
            emit([{ type: "error", error: this.failure(session, error) }])
          } finally {
            session.listener = undefined
            options.abortSignal?.removeEventListener("abort", cancel)
            if (oneShot) this.close(session)
            if (!closed)
              try {
                controller.close()
              } catch {}
          }
        },
        cancel,
      }),
    }
  }

  stop() {
    for (const session of [...this.live]) this.close(session)
  }
}
