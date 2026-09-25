export * as AcpRuntime from "./runtime.js"

import { execFile, spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
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
import { DelegateContext } from "@opencode/plugin/effect/delegate-context"
import type {
  DelegatedApproval,
  DelegatedInstructionFile,
  DelegatedSkillSummary,
  DelegatedPermissionCheck,
  DelegatedStreamResult,
  DelegatedSystemPrompt,
  DelegatedToolBinding,
  DelegatedTurn,
} from "@opencode/plugin/effect/delegate"
import { AcpContext } from "./context.js"
import { AcpHostTools } from "./host-tools.js"
import { AcpModels } from "./models.js"
import { AcpPlan } from "./plan.js"
import { AcpOptions } from "./options.js"
import { AcpPermissions } from "./permissions.js"
import { AcpTranslate } from "./translate.js"

export type Selection = "normal" | "auto" | "native_auto"

/** What the runtime needs from the host, as plain async calls (the plugin binds them to `ctx`). */
export interface Host {
  readonly cwd: string
  readonly mode: () => Promise<Selection>
  /** Asks the host policy (prompting when it asks); a decline may carry the user's correction. */
  readonly approve: (check: DelegatedPermissionCheck) => Promise<DelegatedApproval>
  /** The host tools a primary turn may use, bound to its attribution; absent when it has none. */
  readonly tools?: (turn: DelegatedTurn) => Promise<DelegatedToolBinding | undefined>
  /** The agent session a host session last used, kept across host restarts. */
  readonly cursor?: {
    readonly get: (sessionID: string) => Promise<string | undefined>
    readonly set: (sessionID: string, acpSessionID: string) => Promise<void>
  }
  /**
   * The host context for a primary turn: the agent's profile, instruction files and, when the
   * agent can load them, skills. Absent when the host sends no context.
   */
  readonly context?: (
    turn: DelegatedTurn,
    input: { readonly skills: boolean },
  ) => Promise<{
    readonly agent: DelegateContext.Agent
    readonly isWorker: boolean
    readonly files?: readonly DelegatedInstructionFile[]
    readonly skills?: readonly DelegatedSkillSummary[]
  }>
  /**
   * The host's base prompt for a primary turn's agent, with guidance for `tools` (the host tool ids
   * served to the agent session); for an agent with `prompt: "prefix"`.
   */
  readonly system?: (turn: DelegatedTurn, tools: readonly string[]) => Promise<DelegatedSystemPrompt | undefined>
  /** The agent's own model list, as each new agent session reports it. */
  readonly onModels?: (models: readonly AcpModels.Discovered[]) => void
}

export interface Process {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly kill: () => void
  readonly exited: Promise<unknown>
  /** What the agent wrote to stderr, most recent last; for failure messages. */
  readonly stderr?: () => string
}

/** How much of the agent's stderr is kept for failure messages. */
const STDERR_TAIL = 4_000

/** How long a cancelled turn waits for the agent to stop on its own before its process is killed. */
export const INTERRUPT_GRACE_MS = 5_000

export type Spawn = (agent: AcpOptions.Agent, cwd: string, extraArgs: readonly string[]) => Process

/** Writes the files of the home the host manages for the agent; they are the host's, so overwritten. */
export const prepareHome = (home: NonNullable<AcpOptions.Agent["home"]>) => {
  for (const [name, content] of Object.entries(home.files)) {
    const target = path.resolve(home.path, name)
    if (!target.startsWith(path.resolve(home.path) + path.sep))
      throw new Error(`Home file ${name} is outside ${home.path}.`)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

/** The agent process environment: the host's, the configured additions, and the managed home. */
const environment = (agent: AcpOptions.Agent) => ({
  ...process.env,
  ...agent.env,
  ...(agent.home ? { [agent.home.env]: agent.home.path } : {}),
})

/** Account details from a `whoami` command's JSON output: its string fields. */
export const account = (stdout: string): Record<string, string> => {
  try {
    const value = JSON.parse(stdout)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string" && !!pair[1]),
    )
  } catch {
    return {}
  }
}

export const spawnProcess: Spawn = (agent, cwd, extraArgs) => {
  const child = spawn(agent.command, [...agent.args, ...extraArgs], {
    cwd,
    env: environment(agent),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + String(chunk)).slice(-STDERR_TAIL)
  })
  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    kill: () => void child.kill(),
    exited: new Promise((resolve) => {
      child.once("exit", resolve)
      child.once("error", resolve)
    }),
    stderr: () => stderr.trim(),
  }
}

/** The agent's stderr as a failure message suffix. */
const said = (process: Process) => {
  const tail = process.stderr?.()
  return tail ? `\nThe agent said:\n${tail}` : ""
}

const sameArgs = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index])

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
  /** The approval flags the process was launched with (`nativeApprovalArgs` or `autoApprovalArgs`). */
  readonly launch: readonly string[]
  /** The agent can reload this session into a new process (`session/load`). */
  readonly loadable: boolean
  /** The host tool catalog the agent session was started with. */
  readonly catalog: string
  /** Host tools served to this session; absent when there are none or the agent takes no HTTP MCP servers. */
  readonly slot?: AcpHostTools.Slot
  readonly modes: ReadonlySet<string>
  readonly initialMode?: string
  currentMode?: string
  /** How to switch the session's model, when the agent reports a selector. */
  readonly model?: { readonly control: AcpModels.Control; readonly initial?: string; current?: string }
  /** The agent's plans, mirrored into the host's todo list. */
  readonly plans: AcpPlan.Plans
  agent?: string
  listener?: (update: SessionUpdate) => void
  /** Corrections the user typed into declines; ACP has no channel for them but the next prompt. */
  readonly corrections: string[]
}

export interface Options {
  readonly spawn?: Spawn
  readonly interruptGraceMs?: number
}

export class Runtime {
  private readonly sessions = new Map<string, Session>()
  /** Every open agent process, including one-shot ones. */
  private readonly live = new Set<Session>()
  private readonly endpoint = new AcpHostTools.Endpoint()
  /** The model a new agent session starts with; a loaded session reports the one it last used. */
  private defaultModel?: string
  private readonly context: DelegateContext.Tracker
  /** The base prompt (its static part) each host session's agent session last received. */
  private readonly based = new Map<string, string>()
  /** Host sessions with a primary turn in flight, from acquisition to the end of its stream. */
  private readonly turns = new Set<string>()
  private readonly spawn: Spawn
  private readonly interruptGraceMs: number

  constructor(
    private readonly agent: AcpOptions.Agent,
    private readonly host: Host,
    options: Options = {},
  ) {
    this.spawn = options.spawn ?? spawnProcess
    this.interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS
    this.context = new DelegateContext.Tracker({
      inherited: AcpContext.inherited(host.cwd, agent.inheritedInstructions),
      skillTool: AcpContext.SKILL_TOOL,
      // A sent base prompt already carries the agent's own prompt.
      brief: agent.prompt === "prefix" && host.system ? AcpContext.workerBrief : AcpContext.brief,
    })
  }

  /**
   * What the host context adds to this turn. Sent ahead of the prompt; a compaction command goes
   * alone, and the agent holds none of the earlier context after it.
   */
  private async prepareContext(
    turn: DelegatedTurn,
    session: Session,
    binding: DelegatedToolBinding | undefined,
    fresh: boolean,
  ): Promise<DelegateContext.Delivery | undefined> {
    const base = await this.prepareBase(turn, session, fresh)
    const context = await this.prepareHostContext(turn, session, binding, fresh)
    if (!base) return context
    return {
      text: [base.text, context?.text].filter(Boolean).join("\n\n"),
      delivered: () => {
        base.delivered()
        context?.delivered()
      },
    }
  }

  /**
   * The host's base prompt, for an agent that takes it ahead of the prompt: sent to each new agent
   * session (and after compaction), and again when it changes (another agent, other tools).
   */
  private async prepareBase(turn: DelegatedTurn, session: Session, fresh: boolean) {
    if (this.agent.prompt !== "prefix" || !this.host.system) return undefined
    if (fresh) this.based.delete(turn.sessionID)
    const tools = session.slot?.definitions.map((item) => item.name) ?? []
    const system = await this.host.system(turn, tools).catch(() => undefined)
    const text = system && AcpContext.base(system)
    if (!system || !text) return undefined
    const key = JSON.stringify(system.static)
    if (key === this.based.get(turn.sessionID)) return undefined
    return { text, delivered: () => void this.based.set(turn.sessionID, key) }
  }

  private async prepareHostContext(
    turn: DelegatedTurn,
    session: Session,
    binding: DelegatedToolBinding | undefined,
    fresh: boolean,
  ) {
    if (!this.host.context) return undefined
    const served = (name: string) => session.slot?.definitions.some((item) => item.name === name) === true
    const gathered = await this.host.context(turn, { skills: served("skill") }).catch(() => undefined)
    if (!gathered) return undefined
    return this.context.prepare(turn.sessionID, {
      ...gathered,
      skills: gathered.skills ?? [],
      codeMode: served(AcpHostTools.CODE_MODE) ? (binding?.codeMode ?? null) : null,
      fresh,
    })
  }

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
        if (notification.update.sessionUpdate === "config_option_update" && session.model?.control.kind === "config") {
          const current = AcpModels.fromConfig(notification.update.configOptions)?.current
          if (current) session.model.current = current
        }
        session.listener?.(notification.update)
      },
      requestPermission: async (request) => {
        const session = current()
        if (!session || request.sessionId !== session.acpSessionID) return { outcome: { outcome: "cancelled" } }
        // The host's own tools apply the host's permission policy when they execute.
        if (session.slot?.owns(request.toolCall.toolCallId)) return AcpPermissions.respond(request, true)
        const check = AcpPermissions.check(request, { sessionID: session.sessionID, agent: session.agent })
        const approval = await this.host.approve(check).catch((): DelegatedApproval => ({ ok: false }))
        if (!approval.ok && approval.feedback)
          session.corrections.push(AcpPermissions.correction(request.toolCall, approval.feedback))
        return AcpPermissions.respond(request, approval.ok)
      },
    }
  }

  /**
   * Starts an agent process with a session: a new one, or `resume` loaded back when the agent
   * supports it. `resumed` says whether the agent still holds the conversation.
   */
  private homeReady = false

  private async open(
    sessionID: string,
    input: {
      readonly launch: readonly string[]
      readonly resume?: string
      readonly tools?: { readonly catalog: string; readonly definitions: DelegatedToolBinding["definitions"] }
    } = { launch: [] },
  ): Promise<{ readonly session: Session; readonly resumed: boolean }> {
    if (this.agent.home && !this.homeReady) {
      prepareHome(this.agent.home)
      this.homeReady = true
    }
    const process = this.spawn(this.agent, this.host.cwd, input.launch)
    let opened: Session | undefined
    let slot: AcpHostTools.Slot | undefined
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
      slot =
        input.tools?.definitions.length && initialized.agentCapabilities?.mcpCapabilities?.http
          ? new AcpHostTools.Slot(input.tools.catalog, input.tools.definitions)
          : undefined
      const mcpServers = slot ? [await this.endpoint.entry(slot)] : []
      if (slot) this.endpoint.attach(slot)
      // The agent replays a loaded conversation as session updates; they arrive before `opened` is
      // set and are dropped, since the host already holds that transcript.
      const loaded =
        input.resume && loadable
          ? await connection
              .loadSession({ sessionId: input.resume, cwd: this.host.cwd, mcpServers })
              .then((response) => ({ ...response, sessionId: input.resume! }))
              .catch(() => undefined)
          : undefined
      const created = loaded ?? (await connection.newSession({ cwd: this.host.cwd, mcpServers }))
      const models = AcpModels.read(created)
      if (models?.models.length) this.host.onModels?.(models.models)
      if (!loaded && models?.current) this.defaultModel ??= models.current
      const session: Session = {
        sessionID,
        exited: false,
        process,
        connection,
        acpSessionID: created.sessionId,
        launch: input.launch,
        loadable,
        catalog: input.tools?.catalog ?? "",
        plans: new Map(),
        corrections: [],
        ...(slot ? { slot } : {}),
        modes: new Set(created.modes?.availableModes.map((mode) => mode.id) ?? []),
        ...(created.modes
          ? { initialMode: created.modes.currentModeId, currentMode: created.modes.currentModeId }
          : {}),
        ...(models?.control
          ? {
              model: {
                control: models.control,
                ...(models.current ? { initial: models.current, current: models.current } : {}),
              },
            }
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
      if (slot) this.endpoint.detach(slot)
      process.kill()
      // The agent's own reason lands on stderr after the connection drops; give it a moment.
      await Promise.race([process.exited, new Promise((resolve) => setTimeout(resolve, 200))])
      throw new Error(
        `${this.agent.name} did not start an ACP session: ${error instanceof Error ? error.message : String(error)}${said(process)}`,
      )
    }
  }

  private forget(session: Session) {
    if (session.slot) this.endpoint.detach(session.slot)
    this.live.delete(session)
    if (this.sessions.get(session.sessionID) === session) this.sessions.delete(session.sessionID)
  }

  private close(session: Session) {
    this.forget(session)
    session.process.kill()
  }

  /** The host session is gone: its agent process goes too (its cursor is the plugin's to remove). */
  drop(sessionID: string) {
    const session = this.sessions.get(sessionID)
    if (session) this.close(session)
  }

  /**
   * A failure as this agent's own error. Connection errors carry network-style codes (EPIPE when the
   * process is gone) that the host would otherwise report as a bare transport failure.
   */
  private failure(session: Session, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return new Error(
      (session.exited
        ? `${this.agent.name} exited during the turn${detail ? ` (${detail})` : ""}.`
        : `${this.agent.name} failed: ${detail || "unknown error"}`) + said(session.process),
    )
  }

  /** The agent's own session mode follows the host's selection, where it has one for it. */
  private async applyMode(session: Session, selection: Selection) {
    const wanted = AcpOptions.sessionMode(this.agent, selection) ?? this.agent.defaultMode ?? session.initialMode
    if (!wanted || wanted === session.currentMode || !session.modes.has(wanted)) return
    await session.connection.setSessionMode({ sessionId: session.acpSessionID, modeId: wanted })
    session.currentMode = wanted
  }

  /**
   * Serves the host's model selection. `default` is the model the agent gives a new session (a
   * loaded session reports the one it last used). The agent validates the id when it prompts.
   */
  private async applyModel(session: Session, modelID: string) {
    const model = session.model
    if (!model) return
    const wanted = modelID === "default" ? (this.defaultModel ?? model.initial) : modelID
    if (!wanted || wanted === model.current) return
    if (model.control.kind === "config")
      await session.connection.setSessionConfigOption({
        sessionId: session.acpSessionID,
        configId: model.control.configId,
        value: wanted,
      })
    else
      await session.connection.request(AcpModels.LEGACY_SET_MODEL, { sessionId: session.acpSessionID, modelId: wanted })
    model.current = wanted
  }

  /**
   * Whether the agent is signed in, and as whom: its `whoami` command when it has one, otherwise a
   * throwaway ACP session that must start. Rejects with the agent's sign-in hint.
   */
  async signedIn(): Promise<Record<string, string>> {
    const hint = this.agent.integration.signIn ?? `Check that ${this.agent.name} is installed and signed in.`
    const whoami = this.agent.integration.whoami
    if (!whoami) {
      await this.discover().catch((error) => {
        throw new Error(`${this.agent.name} did not start: ${error instanceof Error ? error.message : error}. ${hint}`)
      })
      return {}
    }
    return new Promise((resolve, reject) =>
      execFile(
        this.agent.command,
        [...whoami],
        { cwd: this.host.cwd, env: environment(this.agent), timeout: 20_000 },
        (error, stdout) =>
          error ? reject(new Error(`${this.agent.name} is not signed in. ${hint}`)) : resolve(account(stdout)),
      ),
    )
  }

  /** Starts a throwaway agent session to learn its model list (reported through `onModels`). */
  async discover() {
    const { session } = await this.open("discover")
    this.close(session)
  }

  /**
   * The live session for a turn. The approval selection is read once per turn, so switching modes
   * costs nothing until the next prompt, and switching back before then costs nothing at all. An
   * agent whose approval is a launch flag is restarted only when the selection's flags differ from
   * how its process was launched; the conversation is loaded back into the new process. A host
   * session this process has not run yet resumes the agent session it last used.
   *
   * `remembers` says whether the agent holds the conversation. When it does not (nothing to
   * load, or the load failed) and the host transcript has history, the whole transcript is sent.
   */
  private async acquire(
    turn: DelegatedTurn,
    selection: Selection,
    tools: { readonly catalog: string; readonly definitions: DelegatedToolBinding["definitions"] },
    history: boolean,
  ) {
    const launch = AcpOptions.launchArgs(this.agent, selection)
    const existing = this.sessions.get(turn.sessionID)
    // The agent lists host tools once per session, so a changed catalog also needs a relaunch.
    if (existing && sameArgs(existing.launch, launch) && existing.catalog === tools.catalog)
      return { session: existing, remembers: true }
    if (existing) this.close(existing)
    const resume = existing?.acpSessionID ?? (await this.host.cursor?.get(turn.sessionID).catch(() => undefined))
    const opened = await this.open(turn.sessionID, { launch, tools, ...(resume ? { resume } : {}) })
    this.sessions.set(turn.sessionID, opened.session)
    if (opened.session.acpSessionID !== resume)
      await this.host.cursor?.set(turn.sessionID, opened.session.acpSessionID).catch(() => {})
    return { session: opened.session, remembers: opened.resumed || !history }
  }

  async turn(turn: DelegatedTurn, options: LanguageModelV3CallOptions): Promise<DelegatedStreamResult> {
    const oneShot = turn.kind !== "primary"
    if (!(oneShot ? flatten(options.prompt) : promptDelta(options.prompt)))
      throw new Error(`No user prompt to deliver to ${this.agent.name}.`)
    if (!oneShot && this.turns.has(turn.sessionID))
      throw new Error(`${this.agent.name} session is already processing a turn.`)
    if (!oneShot) this.turns.add(turn.sessionID)
    const release = () => void (oneShot || this.turns.delete(turn.sessionID))
    try {
      return await this.start(turn, options, oneShot, release)
    } catch (error) {
      release()
      throw error
    }
  }

  private async start(
    turn: DelegatedTurn,
    options: LanguageModelV3CallOptions,
    oneShot: boolean,
    release: () => void,
  ): Promise<DelegatedStreamResult> {
    // One-shots (titles, generation) run under Manual in a throwaway process. `native_auto` on an
    // agent without a judgement-based mode of its own is Manual here, as the host treats it.
    const selected = oneShot ? "normal" : await this.host.mode()
    const selection: Selection =
      selected === "native_auto" && !AcpOptions.hasNativeApproval(this.agent) ? "normal" : selected
    // Bound at the turn boundary: calls during the turn carry its attribution.
    const binding = oneShot ? undefined : await this.host.tools?.(turn)
    const available =
      options.toolChoice?.type === "none"
        ? []
        : (options.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool.name] : []))
    const definitions = binding ? AcpHostTools.select(binding, this.agent.hostTools, available) : []
    const { session, remembers } = oneShot
      ? { session: (await this.open(turn.sessionID)).session, remembers: false }
      : await this.acquire(
          turn,
          selection,
          { catalog: AcpHostTools.catalogKey(definitions), definitions },
          options.prompt.some((message) => message.role === "assistant"),
        )
    const delta = remembers ? promptDelta(options.prompt) : flatten(options.prompt)
    const compacting = !oneShot && !!this.agent.compactCommand && delta.trim() === this.agent.compactCommand
    const delivery = oneShot || compacting ? undefined : await this.prepareContext(turn, session, binding, !remembers)
    const corrections = oneShot || compacting ? [] : session.corrections.splice(0)
    const prompt = AcpContext.wrap(delivery?.text, AcpContext.corrected(corrections, delta))
    session.agent = turn.agent
    if (!oneShot) await this.applyMode(session, selection)
    await this.applyModel(session, turn.modelID).catch((error) => {
      if (oneShot) this.close(session)
      throw this.failure(session, error)
    })

    const state = AcpTranslate.make(session.slot)
    // The agent's plan becomes the host's todo list through the host's own todowrite, so it is
    // stored and rendered as if the agent had called it. Only when the turn may use todowrite.
    const todowrite =
      definitions.some((item) => item.name === AcpPlan.TOOL) && turn.assistantMessageID ? binding : undefined
    const recording: Promise<void>[] = []
    let plans = 0
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    // Cancel is a notification the agent may ignore; a turn that does not end in time is ended
    // by killing the process, which rejects the pending prompt.
    const cancel = () => {
      void session.connection.cancel({ sessionId: session.acpSessionID }).catch(() => {})
      grace ??= setTimeout(() => {
        if (!settled) this.close(session)
      }, this.interruptGraceMs)
    }
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
          const record = (todos: readonly AcpPlan.Todo[]) => {
            const toolCallId = `acp-plan-${turn.assistantMessageID}-${++plans}`
            const input = { todos }
            emit([
              {
                type: "tool-call",
                toolCallId,
                toolName: AcpPlan.TOOL,
                input: JSON.stringify(input),
                providerExecuted: true,
              },
            ])
            const settle = (result: unknown, isError?: boolean) =>
              emit([
                {
                  type: "tool-result",
                  toolCallId,
                  toolName: AcpPlan.TOOL,
                  result,
                  ...(isError ? { isError } : {}),
                } as LanguageModelV3StreamPart,
              ])
            recording.push(
              todowrite!
                .execute({
                  name: AcpPlan.TOOL,
                  args: input,
                  callID: toolCallId,
                  signal: options.abortSignal ?? new AbortController().signal,
                })
                .then(
                  (result) => {
                    const output = AcpHostTools.resultText(result)
                    settle(result.metadata === undefined ? output : { output, metadata: result.metadata })
                  },
                  (error) => settle(error instanceof Error ? error.message : String(error), true),
                ),
            )
          }
          // Host tool calls the agent never reports still ran: they render from the host's side.
          if (binding && turn.assistantMessageID)
            session.slot?.bind(binding, turn.assistantMessageID, {
              called: (id, name, args) => emit(AcpTranslate.hostCall(state, id, name, args)),
              settled: (id, error) => emit(AcpTranslate.hostResult(state, id, error)),
            })
          session.listener = (update) => {
            const todos = todowrite ? AcpPlan.apply(session.plans, update) : undefined
            if (todos) record(todos)
            emit(AcpTranslate.update(state, update))
          }
          options.abortSignal?.addEventListener("abort", cancel, { once: true })
          if (options.abortSignal?.aborted) cancel()
          try {
            const response = await session.connection.prompt({
              sessionId: session.acpSessionID,
              prompt: [{ type: "text", text: prompt }],
            })
            settled = true
            await Promise.all(recording)
            if (compacting) {
              this.context.clear(turn.sessionID)
              this.based.delete(turn.sessionID)
            } else if (response.stopReason !== "cancelled") delivery?.delivered()
            emit(AcpTranslate.finish(state, response.stopReason))
          } catch (error) {
            settled = true
            // Let an exit notification land first so the message can say the process is gone.
            await Promise.race([session.process.exited, new Promise((resolve) => setTimeout(resolve, 50))])
            await Promise.all(recording)
            // A turn the host cancelled ended as asked, however the agent went.
            if (options.abortSignal?.aborted) emit(AcpTranslate.finish(state, "cancelled"))
            else emit([{ type: "error", error: this.failure(session, error) }])
          } finally {
            settled = true
            if (grace !== undefined) clearTimeout(grace)
            session.listener = undefined
            session.slot?.unbind()
            options.abortSignal?.removeEventListener("abort", cancel)
            if (oneShot) this.close(session)
            release()
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
    this.endpoint.stop()
  }
}
