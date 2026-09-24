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
import { AcpOptions } from "./options.js"
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

export type Spawn = (agent: AcpOptions.Agent, cwd: string, extraArgs: readonly string[]) => Process

export const spawnProcess: Spawn = (agent, cwd, extraArgs) => {
  const child = spawn(agent.command, [...agent.args, ...extraArgs], {
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
  /** Launched with the agent's auto-approval flags (`nativeApprovalArgs`). */
  readonly trusted: boolean
  /** The agent can reload this session into a new process (`session/load`). */
  readonly loadable: boolean
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

  /**
   * Starts an agent process with a session: a new one, or `resume` loaded back when the agent
   * supports it. `resumed` says whether the agent still holds the conversation.
   */
  private async open(
    sessionID: string,
    input: { readonly trusted: boolean; readonly resume?: string } = { trusted: false },
  ): Promise<{ readonly session: Session; readonly resumed: boolean }> {
    const process = this.spawn(this.agent, this.host.cwd, input.trusted ? (this.agent.nativeApprovalArgs ?? []) : [])
    let opened: Session | undefined
    const connection = new ClientSideConnection(
      () => this.client(() => opened),
      ndJsonStream(process.stdin, process.stdout),
    )
    try {
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // The agent keeps its own file and terminal tools (decision D6 is still open).
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const loadable = initialized.agentCapabilities?.loadSession === true
      // The agent replays a loaded conversation as session updates; they arrive before `opened` is
      // set and are dropped, since the host already holds that transcript.
      const loaded =
        input.resume && loadable
          ? await connection
              .loadSession({ sessionId: input.resume, cwd: this.host.cwd, mcpServers: [] })
              .then((response) => ({ sessionId: input.resume!, modes: response.modes }))
              .catch(() => undefined)
          : undefined
      const created = loaded ?? (await connection.newSession({ cwd: this.host.cwd, mcpServers: [] }))
      const session: Session = {
        sessionID,
        exited: false,
        process,
        connection,
        acpSessionID: created.sessionId,
        trusted: input.trusted,
        loadable,
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
      return { session, resumed: loaded !== undefined }
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
  private async applyMode(session: Session, native: boolean) {
    const wanted =
      native && this.agent.nativeApprovalMode
        ? this.agent.nativeApprovalMode
        : (this.agent.defaultMode ?? session.initialMode)
    if (!wanted || wanted === session.currentMode || !session.modes.has(wanted)) return
    await session.connection.setSessionMode({ sessionId: session.acpSessionID, modeId: wanted })
    session.currentMode = wanted
  }

  /**
   * The live session for a turn. The approval selection is read once per turn, so switching modes
   * costs nothing until the next prompt, and switching back before then costs nothing at all. An
   * agent whose auto-approval is a launch flag is restarted only when the selection differs from
   * how its process was launched; the conversation is loaded back into the new process.
   */
  private async acquire(turn: DelegatedTurn, native: boolean) {
    const trusted = native && Boolean(this.agent.nativeApprovalArgs?.length)
    const existing = this.sessions.get(turn.sessionID)
    if (existing?.listener) throw new Error(`${this.agent.name} session is already processing a turn.`)
    if (existing && existing.trusted === trusted) return { session: existing, remembers: true }
    if (existing) this.close(existing)
    const opened = await this.open(turn.sessionID, {
      trusted,
      ...(existing ? { resume: existing.acpSessionID } : {}),
    })
    this.sessions.set(turn.sessionID, opened.session)
    // A relaunched agent that could not load the conversation is sent the whole transcript. (A
    // session new to this runtime is sent only the new prompt, as before; see the open resume item.)
    return { session: opened.session, remembers: existing ? opened.resumed : true }
  }

  async turn(turn: DelegatedTurn, options: LanguageModelV3CallOptions): Promise<DelegatedStreamResult> {
    const oneShot = turn.kind !== "primary"
    if (!(oneShot ? flatten(options.prompt) : promptDelta(options.prompt)))
      throw new Error(`No user prompt to deliver to ${this.agent.name}.`)
    // One-shots (titles, generation) run untrusted in a throwaway process.
    const native = !oneShot && AcpOptions.hasNativeApproval(this.agent) && (await this.host.mode()) === "native_auto"
    const { session, remembers } = oneShot
      ? { session: (await this.open(turn.sessionID)).session, remembers: false }
      : await this.acquire(turn, native)
    const prompt = remembers ? promptDelta(options.prompt) : flatten(options.prompt)
    session.agent = turn.agent
    if (!oneShot) await this.applyMode(session, native)

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
