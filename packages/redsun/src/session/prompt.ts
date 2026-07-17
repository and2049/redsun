import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { clone, mergeDeep, pipe } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { Wildcard } from "../util/wildcard"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { Goal } from "./goal"
import { $, fileURLToPath } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@redsun/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Permission } from "@/permission"
import { ExtensionWrapper } from "../extension/wrapper"
import { ExtensionContext } from "../extension/context"
import { ExtensionRunner } from "../extension/runner"
import type { Extension } from "../extension/types"
import { PromptTemplate } from "../prompt/template"
import { Entry } from "../entry/entry"
import { orderedToolEntries } from "./tool-order"
import { ContextOptimizer } from "./context-optimizer"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.REDSUN_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(): void
          }[]
          steering: string[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  function queueSteering(sessionID: string, messageID: string) {
    const s = state()[sessionID]
    if (s) {
      s.steering.push(messageID)
      log.info("steering queued", { sessionID, messageID, pending: s.steering.length })
    }
  }

  function drainSteering(sessionID: string): string[] {
    const s = state()[sessionID]
    if (!s || s.steering.length === 0) return []
    const ids = s.steering.slice()
    s.steering = []
    log.info("steering drained", { sessionID, count: ids.length })
    return ids
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
        variant: z.string().optional(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    system: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    const text = input.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n")
    const runner = await ToolRegistry.getRunner()
    const ctx = ExtensionContext.forSession({
      mode: "rpc",
      sessionID: input.sessionID,
      agent: input.agent ?? "",
      projectTrusted: runner.projectTrusted,
      getSystemPrompt: () => "",
    })
    const inputResult = await ExtensionRunner.emit(runner, { type: "input", text } as Extension.InputEvent, ctx)
    const inputEventResult = inputResult as Extension.InputEventResult | undefined
    if (inputEventResult?.action === "transform" && inputEventResult.text !== undefined) {
      const transformedParts = [{ type: "text" as const, text: inputEventResult.text }]
      const message = await createUserMessage({ ...input, parts: transformedParts })
      await Session.touch(input.sessionID)
      if (input.noReply === true) return message
      queueSteering(input.sessionID, message.info.id)
      return loop(input.sessionID)
    }
    if (inputEventResult?.action === "handled") {
      const message = await createUserMessage(input)
      await Session.touch(input.sessionID)
      return message
    }

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    if (input.noReply === true) {
      return message
    }

    queueSteering(input.sessionID, message.info.id)
    return loop(input.sessionID)
  })

  export async function sendMessage(sessionID: string, content: string) {
    await Entry.append(sessionID, {
      type: "custom_message",
      customType: "extension.message",
      content,
      display: true,
    })
    log.info("sendMessage", { sessionID })
  }

  export async function sendUserMessage(sessionID: string, content: string) {
    return prompt({
      sessionID: sessionID as any,
      agent: "extension",
      parts: [{ type: "text", text: content }],
    })
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: `file://${filepath}`,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
      steering: [],
    }
    return controller.signal
  }

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) return
    match.abort.abort()
    for (const item of match.callbacks) {
      item.reject()
    }
    match.steering = []
    const previousStatus = SessionStatus.get(sessionID)
    delete s[sessionID]
    SessionStatus.set(sessionID, { type: "idle", contextUsage: previousStatus.contextUsage })
    return
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    const abort = start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    using _ = defer(() => cancel(sessionID))

    let step = 0
    while (true) {
      const loopRunner = await ToolRegistry.getRunner()
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
        if (drainSteering(sessionID).length > 0) {
          log.info("steering injected, continuing loop", { sessionID })
        } else {
          const activeGoal = await Goal.get(sessionID)
          if (activeGoal) {
            const [agent, model] = await Promise.all([
              Agent.get(lastUser.agent),
              Provider.getModel(lastUser.model.providerID, lastUser.model.modelID),
            ])
            const goalStop = await handleGoalStop({ sessionID, agent, model })
            if (goalStop.action === "continue") continue
          }
          log.info("exiting loop", { sessionID })
          break
        }
      }

      step++
      const turnCtx = ExtensionContext.forSession({
        mode: "rpc",
        sessionID,
        agent: lastUser?.agent ?? "",
        projectTrusted: loopRunner.projectTrusted,
        getSystemPrompt: () => "",
      })
      await ExtensionRunner.emit(loopRunner, { type: "turn_start", turnIndex: step }, turnCtx)
      await using _turnCleanup = defer(async () => {
        await ExtensionRunner.emit(loopRunner, { type: "turn_end", turnIndex: step }, turnCtx)
      })
      if (step === 1)
        ensureTitle({
          session: await Session.get(sessionID),
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          message: msgs.find((m) => m.info.role === "user")!,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        let executionError: Error | undefined
        const subtaskWrapped = ExtensionWrapper.wrapExecute(
          { id: TaskTool.id, init: async () => taskTool } as unknown as ExtensionWrapper.ResolvedTool,
          loopRunner,
          { path: "", scope: "builtin" },
          () =>
            ExtensionContext.forSession({
              mode: "rpc",
              sessionID,
              agent: task.agent,
              projectTrusted: loopRunner.projectTrusted,
              getSystemPrompt: () => "",
            }),
        )
        const result = await subtaskWrapped
          .execute(taskArgs, {
            agent: task.agent,
            messageID: assistantMessage.id,
            sessionID: sessionID,
            abort,
            callID: part.callID,
            async metadata(input) {
              await Session.updatePart({
                ...part,
                type: "tool",
                state: {
                  ...part.state,
                  ...input,
                },
              } satisfies MessageV2.ToolPart)
            },
          })
          .catch((error) => {
            executionError = error
            log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
            return undefined
          })
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments: result.attachments as MessageV2.FilePart[] | undefined,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        // Add synthetic user message to prevent certain reasoning models from erroring
        // If we create assistant messages w/ out user ones following mid loop thinking signatures
        // will be missing and it can cause errors for models like gemini for example
        const summaryUserMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        await Session.updateMessage(summaryUserMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: summaryUserMsg.id,
          sessionID,
          type: "text",
          text: "Summarize the task tool output above and continue with your task.",
          synthetic: true,
        } satisfies MessageV2.TextPart)

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
          fromExtension: task.fromExtension ?? false,
        })
        if (result === "stop") break
        if (result === "cancelled") continue
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model, sessionID }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.maxSteps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = insertReminders({
        messages: msgs,
        agent,
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      const tools = await resolveTools({
        agent,
        sessionID,
        model,
        tools: lastUser.tools,
        processor,
      })

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      const sessionMessages = clone(msgs)
      const compactionCutoff = sessionMessages.find(
        (m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"),
      )?.info.time.created

      const mcpInstructions = await SystemPrompt.mcp()
      const skillsPrompt = await SystemPrompt.skills()
      const system = [
        ...(await SystemPrompt.environmentStable()),
        ...(await SystemPrompt.custom()),
        ...(skillsPrompt ? [skillsPrompt] : []),
        ...SystemPrompt.selfModification(),
        ...SystemPrompt.projectMemory(),
        ...SystemPrompt.goalFeature(),
        ...(mcpInstructions ? [mcpInstructions] : []),
      ]
      const modelMessages = [
        ...(await MessageV2.toModelMessageWithCustom(sessionID, sessionMessages, compactionCutoff)),
        ...(isLastStep
          ? [
              {
                role: "assistant" as const,
                content: MAX_STEPS,
              },
            ]
          : []),
      ]
      const preSampling = ContextOptimizer.breakdown({
        system,
        messages: ContextOptimizer.optimizeModelMessages(modelMessages),
        tools,
      })
      if (
        await SessionCompaction.isPreSamplingOverflow({
          tokens: preSampling.total,
          model,
          sessionID,
        })
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
          overflow: true,
        })
        continue
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system,
        messages: modelMessages,
        tools,
        model,
      })
      if (result === "stop") {
        if (shouldRetryContextOverflow(processor.message.error, msgs)) {
          await SessionCompaction.create({
            sessionID,
            agent: lastUser.agent,
            model: lastUser.model,
            auto: true,
            overflow: true,
          })
          continue
        }
        const goalStop = await handleGoalStop({
          sessionID,
          agent,
          model,
          variant: lastUser.model.variant,
        })
        if (goalStop.action === "continue") continue
        if (drainSteering(sessionID).length > 0) {
          log.info("steering injected after stop, continuing loop", { sessionID })
          continue
        }
        break
      }
      if (ToolRegistry.consumePendingReload()) {
        await ToolRegistry.reload()
        continue
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  export async function handleGoalStop(input: {
    sessionID: string
    agent: Agent.Info
    model: Provider.Model
    variant?: string
    evaluate?: typeof Goal.evaluate
  }): Promise<{ action: "stop" } | { action: "continue" }> {
    const activeGoal = await Goal.get(input.sessionID)
    if (!activeGoal) return { action: "stop" }

    try {
      const latestMessages = await MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
      const judgedMessageID = latestMessages.findLast((msg) => msg.info.role === "assistant")?.info.id
      const verdict = await (input.evaluate ?? Goal.evaluate)({
        sessionID: input.sessionID,
        condition: activeGoal.condition,
        msgs: latestMessages,
        model: input.model,
      })
      if (verdict.ok) {
        log.info("goal satisfied; allowing stop", { sessionID: input.sessionID })
        Goal.publishVerdict({
          sessionID: input.sessionID,
          verdict,
          attempt: activeGoal.react,
          messageID: judgedMessageID,
        })
        await Goal.clear(input.sessionID)
        return { action: "stop" }
      }
      if (verdict.impossible) {
        log.warn("goal impossible; allowing stop", { sessionID: input.sessionID, reason: verdict.reason })
        Goal.publishVerdict({
          sessionID: input.sessionID,
          verdict,
          attempt: activeGoal.react,
          messageID: judgedMessageID,
        })
        await Goal.clear(input.sessionID)
        return { action: "stop" }
      }

      const count = await Goal.bumpReact(input.sessionID)
      if (count > 12) {
        log.warn("goal hit react cap; allowing stop", { sessionID: input.sessionID })
        Goal.publishVerdict({
          sessionID: input.sessionID,
          verdict,
          attempt: count,
          messageID: judgedMessageID,
        })
        await Goal.clear(input.sessionID)
        return { action: "stop" }
      }

      log.info("goal not satisfied; re-entering", { sessionID: input.sessionID, attempt: count })
      Goal.publishVerdict({
        sessionID: input.sessionID,
        goal: { condition: activeGoal.condition },
        verdict,
        attempt: count,
        messageID: judgedMessageID,
      })
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent.name,
        model: { providerID: input.model.providerID, modelID: input.model.id, variant: input.variant },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID,
        sessionID: input.sessionID,
        type: "text",
        text: `Your goal is not yet satisfied: "${activeGoal.condition}".\n\nThe independent judge noted:\n${verdict.reason}\n\nKeep working toward the goal. Do not stop until it is genuinely met or impossible.`,
        synthetic: true,
      })
      return { action: "continue" }
    } catch (err) {
      log.warn("goal judge failed; allowing stop", { error: String(err) })
      Goal.publishVerdict({
        sessionID: input.sessionID,
        goal: { condition: activeGoal.condition },
        verdict: { ok: false, reason: String(err) },
        attempt: activeGoal.react,
        error: true,
      })
      return { action: "stop" }
    }
  }

  export function shouldRetryContextOverflow(
    error: MessageV2.Assistant["error"],
    messages: MessageV2.WithParts[],
  ) {
    if (!MessageV2.ContextOverflowError.isInstance(error)) return false
    return !messages.some((message) =>
      message.parts.some((part) => part.type === "compaction" && part.overflow === true),
    )
  }

  async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    sessionID: string
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}
    const enabledTools = pipe(
      input.agent.tools,
      mergeDeep(await ToolRegistry.enabled(input.agent)),
      mergeDeep(input.tools ?? {}),
    )
    const runner = await ToolRegistry.getRunner()
    const extContextFactory = () =>
      ExtensionContext.forSession({
        mode: "rpc",
        sessionID: input.sessionID,
        agent: input.agent.name,
        projectTrusted: runner.projectTrusted,
        getSystemPrompt: () => "",
        signal: input.processor.message.id ? undefined : undefined,
      })
    for (const item of await ToolRegistry.tools(input.model.providerID, input.agent)) {
      if (Wildcard.all(item.id, enabledTools) === false) continue
      if (!ExtensionRunner.isToolActive(runner, item.id)) continue
      const rawSchema = z.toJSONSchema(item.parameters) as any
      const schema = ProviderTransform.schema(input.model, {
        ...rawSchema,
        properties: rawSchema.properties ?? {},
      })
      const wrapped = ExtensionWrapper.wrapExecute(
        item as ExtensionWrapper.ResolvedTool,
        runner,
        { path: "", scope: "builtin" },
        extContextFactory,
      )
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const result = await wrapped.execute(args as Record<string, unknown>, {
            sessionID: input.sessionID,
            abort: options.abortSignal!,
            messageID: input.processor.message.id,
            callID: options.toolCallId,
            extra: { model: input.model },
            agent: input.agent.name,
            metadata: async (val) => {
              const match = input.processor.partFromToolCall(options.toolCallId)
              if (match && match.state.status === "running") {
                await Session.updatePart({
                  ...match,
                  state: {
                    title: val.title,
                    metadata: val.metadata,
                    status: "running",
                    input: args,
                    time: {
                      start: Date.now(),
                    },
                  },
                })
              }
            },
          })
          return result
        },
        toModelOutput(result) {
          return {
            type: "text",
            value: result.output,
          }
        },
      })
    }
    for (const [key, item] of orderedToolEntries(await MCP.tools(input.model))) {
      if (Wildcard.all(key, enabledTools) === false) continue
      if (!ExtensionRunner.isToolActive(runner, key)) continue
      const execute = item.execute
      if (!execute) continue

      // Wrap execute to add extension hooks and format output
      item.execute = async (args, opts) => {
        const ctx = extContextFactory()
        const callResult = await ExtensionRunner.emit(
          runner,
          {
            type: "tool_call",
            toolCallId: opts?.toolCallId ?? "",
            toolName: key,
            input: args,
          } as Extension.ToolCallEvent,
          ctx,
        )
        if ((callResult as Extension.ToolCallResult)?.block) {
          throw new Error((callResult as Extension.ToolCallResult).reason ?? "execution blocked by extension")
        }

        let result: Awaited<ReturnType<typeof execute>>
        try {
          result = await execute(args, opts)
        } catch (error) {
          await ExtensionRunner.emit(
            runner,
            {
              type: "tool_result",
              toolCallId: opts?.toolCallId ?? "",
              toolName: key,
              input: args,
              output: error instanceof Error ? error.message : String(error),
              metadata: {},
              isError: true,
            } satisfies Extension.ToolResultEvent,
            ctx,
          )
          throw error
        }

        const textParts: string[] = []
        const attachments: MessageV2.FilePart[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.sessionID,
              messageID: input.processor.message.id,
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          }
        }

        const output = textParts.join("\n\n")
        const resultResult = await ExtensionRunner.emit(
          runner,
          {
            type: "tool_result",
            toolCallId: opts?.toolCallId ?? "",
            toolName: key,
            input: args,
            output,
            metadata: result.metadata ?? {},
          } as Extension.ToolResultEvent,
          ctx,
        )
        const mutated = resultResult as Extension.ToolResultEventResult | undefined

        return {
          title: "",
          metadata: mutated?.metadata ?? result.metadata ?? {},
          output: mutated?.output ?? output,
          attachments,
          content: result.content,
        }
      }
      item.toModelOutput = (result) => {
        return {
          type: "text",
          value: result.output,
        }
      }
      tools[key] = item
    }

    const mcpClients = await MCP.clients()
    const hasMcpResourceServer = Object.values(mcpClients).some(
      (client) => !!client.getServerCapabilities()?.resources,
    )
    if (hasMcpResourceServer) {
      const resourceServers = Object.entries(mcpClients)
        .filter(([, client]) => !!client.getServerCapabilities()?.resources)
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b))

      tools["list_mcp_resources"] = tool({
        description:
          "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
        inputSchema: jsonSchema(
          ProviderTransform.schema(input.model, {
            type: "object",
            properties: {
              server: {
                type: "string",
                description: "Optional MCP server name. When omitted, lists resources from every connected server.",
              },
            },
            additionalProperties: false,
          } as any) as any,
        ),
        async execute(args, opts) {
          const server = (args as any)?.server as string | undefined
          if (server && !resourceServers.includes(server)) {
            throw new Error(
              resourceServers.length === 0
                ? `MCP server "${server}" does not support resources`
                : `MCP server "${server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
            )
          }
          const permissionPatterns = server ? [`mcp:${server}:*`] : resourceServers.map((s) => `mcp:${s}:*`)
          await Permission.ask({
            type: "read",
            title: server ? `MCP resources: ${server}` : "MCP resources",
            pattern: permissionPatterns,
            callID: opts.toolCallId,
            sessionID: input.sessionID,
            messageID: input.processor.message.id,
            metadata: server ? { server } : {},
          })
          const resources = await MCP.resources(server)
          const filtered = Object.values(resources)
            .filter((r) => !server || r.client === server)
            .sort((a, b) => (a.client + "\0" + a.name + "\0" + a.uri).localeCompare(b.client + "\0" + b.name + "\0" + b.uri))
          const formatted = filtered.map((r) => {
            const { client, ...rest } = r
            return { ...rest, server: client }
          })
          const content = JSON.stringify({ resources: formatted }, null, 2)
          return {
            title: server ? `MCP resources: ${server}` : "MCP resources",
            metadata: { count: filtered.length, servers: resourceServers, ...(server ? { server } : {}) },
            output: content,
          }
        },
        toModelOutput(result) {
          return { type: "text", value: result.output }
        },
      })

      tools["list_mcp_resource_templates"] = tool({
        description:
          "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
        inputSchema: jsonSchema(
          ProviderTransform.schema(input.model, {
            type: "object",
            properties: {
              server: {
                type: "string",
                description:
                  "Optional MCP server name. When omitted, lists resource templates from every connected server.",
              },
            },
            additionalProperties: false,
          } as any) as any,
        ),
        async execute(args, opts) {
          const server = (args as any)?.server as string | undefined
          if (server && !resourceServers.includes(server)) {
            throw new Error(
              resourceServers.length === 0
                ? `MCP server "${server}" does not support resources`
                : `MCP server "${server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
            )
          }
          const permissionPatterns = server ? [`mcp:${server}:*`] : resourceServers.map((s) => `mcp:${s}:*`)
          await Permission.ask({
            type: "read",
            title: server ? `MCP resource templates: ${server}` : "MCP resource templates",
            pattern: permissionPatterns,
            callID: opts.toolCallId,
            sessionID: input.sessionID,
            messageID: input.processor.message.id,
            metadata: server ? { server } : {},
          })
          const templates = await MCP.resourceTemplates(server)
          const filtered = Object.values(templates)
            .filter((t) => !server || t.client === server)
            .sort((a, b) =>
              (a.client + "\0" + a.name + "\0" + a.uriTemplate).localeCompare(
                b.client + "\0" + b.name + "\0" + b.uriTemplate,
              ),
            )
          const formatted = filtered.map((t) => {
            const { client, ...rest } = t
            return { ...rest, server: client }
          })
          const content = JSON.stringify({ resourceTemplates: formatted }, null, 2)
          return {
            title: server ? `MCP resource templates: ${server}` : "MCP resource templates",
            metadata: { count: filtered.length, servers: resourceServers, ...(server ? { server } : {}) },
            output: content,
          }
        },
        toModelOutput(result) {
          return { type: "text", value: result.output }
        },
      })

      const SUPPORTED_MCP_RESOURCE_MIMES = new Set([
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
      ])
      const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024

      function base64Size(value: string) {
        const trimmed = value.replace(/\s/g, "")
        const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
        return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
      }

      function formatBytes(value: number) {
        if (value < 1024) return `${value} B`
        if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
        return `${Math.ceil(value / (1024 * 1024))} MB`
      }

      tools["read_mcp_resource"] = tool({
        description:
          "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
        inputSchema: jsonSchema(
          ProviderTransform.schema(input.model, {
            type: "object",
            properties: {
              server: {
                type: "string",
                description: "MCP server name exactly as returned by list_mcp_resources.",
              },
              uri: {
                type: "string",
                description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
              },
            },
            required: ["server", "uri"],
            additionalProperties: false,
          } as any) as any,
        ),
        async execute(args, opts) {
          const server = (args as any)?.server as string
          const uri = (args as any)?.uri as string
          if (!server) throw new Error("server is required")
          if (!uri) throw new Error("uri is required")
          const client = mcpClients[server]
          if (!client) throw new Error(`MCP server "${server}" is not connected`)
          if (!client.getServerCapabilities()?.resources) {
            throw new Error(`MCP server "${server}" does not support resources`)
          }
          await Permission.ask({
            type: "read",
            title: `MCP resource: ${uri}`,
            pattern: [`mcp:${server}:${uri}`],
            callID: opts.toolCallId,
            sessionID: input.sessionID,
            messageID: input.processor.message.id,
            metadata: { server, uri },
          })
          const content = await MCP.readResource(server, uri)
          if (!content) throw new Error(`Failed to read MCP resource: ${server}/${uri}`)

          const textParts: string[] = []
          const attachments: MessageV2.FilePart[] = []

          for (const item of content.contents) {
            const itemUri = typeof item.uri === "string" ? item.uri : uri
            const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
            if (typeof item.text === "string") {
              textParts.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
              continue
            }
            if (typeof item.blob === "string") {
              const size = base64Size(item.blob)
              if (!SUPPORTED_MCP_RESOURCE_MIMES.has(mime)) {
                textParts.push(`[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`)
                continue
              }
              if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                textParts.push(`[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`)
                continue
              }
              textParts.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
              attachments.push({
                id: Identifier.ascending("part"),
                sessionID: input.sessionID,
                messageID: input.processor.message.id,
                type: "file",
                mime,
                url: `data:${mime};base64,${item.blob}`,
                filename: itemUri,
              })
              continue
            }
            textParts.push(`[MCP resource content without text or blob: ${itemUri}]`)
          }

          const output = textParts.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`
          return {
            title: `MCP resource: ${uri}`,
            metadata: { server, uri, contents: content.contents.length, attachments: attachments.length },
            output,
            attachments,
          }
        },
        toModelOutput(result) {
          return { type: "text", value: result.output }
        },
      })
    }
    return tools
  }

  async function createUserMessage(input: PromptInput) {
    const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))
    const model =
      input.model ??
      ToolRegistry.consumeModelOverride(input.sessionID) ??
      agent.model ??
      (await lastModel(input.sessionID))
    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
    }

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<MessageV2.Part[]> => {
        if (part.type === "file") {
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath).stat()

              if (stat.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI)
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start - 1, 0)
                  if (end) {
                    limit = end - offset
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const result = await t.execute(args, {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      metadata: async () => {},
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const result = await ListTool.init().then((t) =>
                  t.execute(args, {
                    sessionID: input.sessionID,
                    abort: new AbortController().signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true },
                    metadata: async () => {},
                  }),
                )
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              const file = Bun.file(filepath)
              FileTime.read(input.sessionID, filepath)
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                  synthetic: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                "Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name,
            },
          ]
        }

        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat())

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        // TODO (for mr dax): update to use the anthropic full fledged one (see plan-reminder-anthropic.txt)
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
        variant: z.string().optional(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => cancel(input.sessionID))

    const runner = await ToolRegistry.getRunner()
    const extCtx = ExtensionContext.forSession({
      mode: "rpc",
      sessionID: input.sessionID,
      agent: input.agent,
      projectTrusted: runner.projectTrusted,
      getSystemPrompt: () => "",
    })
    const shellInputResult = await ExtensionRunner.emit(
      runner,
      { type: "input", text: input.command } as Extension.InputEvent,
      extCtx,
    )
    if ((shellInputResult as Extension.InputEventResult)?.action === "handled") return

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model =
      input.model ??
      ToolRegistry.consumeModelOverride(input.sessionID) ??
      agent.model ??
      (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        variant: "variant" in model && typeof model.variant === "string" ? model.variant : undefined,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const proc = spawn(shell, args, {
      cwd: Instance.directory,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    variant: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  const argsRegex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)

    const runner = await ToolRegistry.getRunner()
    const extCmd = runner.commands.get(input.command)
    if (extCmd) {
      const ctx = ExtensionContext.forSession({
        mode: "rpc",
        sessionID: input.sessionID,
        agent: input.agent ?? "",
        projectTrusted: runner.projectTrusted,
        getSystemPrompt: () => "",
      })
      const extCmdInputResult = await ExtensionRunner.emit(
        runner,
        { type: "input", text: `/${input.command} ${input.arguments}` } as Extension.InputEvent,
        ctx,
      )
      if ((extCmdInputResult as Extension.InputEventResult)?.action === "handled") return
      await extCmd.handler(input.arguments, ctx)
      return
    }

    if (input.command === Command.Default.GOAL) {
      if (input.arguments.trim().length === 0) {
        await Goal.clear(input.sessionID)
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent ?? (await Agent.defaultAgent()),
          model: { providerID: "system", modelID: "system" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: input.sessionID,
          type: "text",
          text: "Goal cleared.",
          synthetic: true,
        })
        return
      } else {
        const condition = input.arguments.trim()
        await Goal.set(input.sessionID, condition)
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent ?? (await Agent.defaultAgent()),
          model: { providerID: "system", modelID: "system" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID,
          sessionID: input.sessionID,
          type: "text",
          text: `Goal set: ${condition}`,
          synthetic: true,
        })
        return
      }
    }

    const command = await Command.get(input.command)
    if (!command) {
      throw new Error(`Command not found: ${input.command}`)
    }
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const ctx = ExtensionContext.forSession({
      mode: "rpc",
      sessionID: input.sessionID,
      agent: input.agent ?? "",
      projectTrusted: runner.projectTrusted,
      getSystemPrompt: () => "",
    })
    const cmdInputResult = await ExtensionRunner.emit(
      runner,
      { type: "input", text: `/${input.command} ${input.arguments}` } as Extension.InputEvent,
      ctx,
    )
    if ((cmdInputResult as Extension.InputEventResult)?.action === "handled") return

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const placeholders = command.template.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = command.template.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // Apply {{argName}} named-argument substitution for prompt templates.
    // Falls through to the existing $1/$ARGUMENTS behaviour when no args resolve.
    if (/\{\{/.test(command.template)) {
      const pt = await PromptTemplate.get(input.command)
      const argDefs = pt?.arguments?.map((a) => ({ name: a.name, default: a.default }))
      const namedArgs: Record<string, string> = {}
      for (let i = 0; i < args.length; i++) {
        const def = argDefs?.[i]
        if (def) namedArgs[def.name] = args[i]
      }
      template = PromptTemplate.substitute(template, input.arguments, namedArgs, argDefs)
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const model = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(model.providerID, model.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)

    const parts =
      (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: command.description ?? "",
              command: input.command,
              // TODO: how can we make task tool accept a more complex input?
              prompt: await resolvePromptParts(template).then((x) => x.find((y) => y.type === "text")?.text ?? ""),
            },
          ]
        : await resolvePromptParts(template)

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: { ...model, variant: command.variant ?? input.variant ?? model.variant },
      agent: agentName,
      parts,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    message: MessageV2.WithParts
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return
    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return
    const agent = await Agent.get("title")
    if (!agent) return
    const result = await LLM.stream({
      agent,
      user: input.message.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model: await iife(async () => {
        if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
        return (
          (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
        )
      }),
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...MessageV2.toModelMessage([
          {
            info: {
              id: Identifier.ascending("message"),
              role: "user",
              sessionID: input.session.id,
              time: {
                created: Date.now(),
              },
              agent: input.message.info.role === "user" ? input.message.info.agent : await Agent.defaultAgent(),
              model: {
                providerID: input.providerID,
                modelID: input.modelID,
              },
            },
            parts: input.message.parts,
          },
        ]),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text)
      return Session.update(input.session.id, (draft) => {
        const cleaned = text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!cleaned) return

        const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
        draft.title = title
      })
  }
}
