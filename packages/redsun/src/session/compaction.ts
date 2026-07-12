import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { resolveTaskModel } from "../provider/router"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { SessionPrompt } from "./prompt"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { ToolRegistry } from "../tool/registry"
import { ExtensionRunner } from "../extension/runner"
import { ExtensionContext } from "../extension/context"
import type { Extension } from "../extension/types"
import { CompactionExtractor } from "./compaction-extractor"
import PROMPT_COMPACTION_HYBRID from "../agent/prompt/compaction-hybrid.txt"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })
  export const DEFAULT_TRIGGER_THRESHOLD = 0.7
  export const DEFAULT_RESET_THRESHOLD = 0.4

  const autoState = new Map<string, { waitingForReset: boolean }>()

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export function tokenUsageRatio(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const context = input.model.limit.context
    if (context === 0) return 0
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = context - output
    if (usable <= 0) return 1
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    return count / usable
  }

  export function resetAutoState(sessionID?: string) {
    if (sessionID) autoState.delete(sessionID)
    else autoState.clear()
  }

  export async function isOverflow(input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
    sessionID?: string
  }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    if (input.model.limit.context === 0) return false

    const triggerThreshold = config.compaction?.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD
    const resetThreshold = config.compaction?.resetThreshold ?? DEFAULT_RESET_THRESHOLD
    const usage = tokenUsageRatio(input)

    if (!input.sessionID) return usage > triggerThreshold

    const state = autoState.get(input.sessionID) ?? { waitingForReset: false }
    if (usage <= resetThreshold) {
      if (state.waitingForReset) autoState.delete(input.sessionID)
      return false
    }
    if (state.waitingForReset) return false
    if (usage > triggerThreshold) {
      autoState.set(input.sessionID, { waitingForReset: true })
      return true
    }
    return false
  }

  export async function isPreSamplingOverflow(input: {
    tokens: number
    model: Provider.Model
    sessionID?: string
  }) {
    return isOverflow({
      model: input.model,
      sessionID: input.sessionID,
      tokens: {
        input: input.tokens,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
    fromExtension?: boolean
  }) {
    // Emit session_before_compact for extensions to cancel or customize
    const runner = await ToolRegistry.getRunner()
    const compactCtx = ExtensionContext.forSession({
      mode: "rpc",
      sessionID: input.sessionID,
      agent: "compaction",
      projectTrusted: runner.projectTrusted,
      getSystemPrompt: () => "",
      signal: input.abort,
    })
    const beforeResult = await ExtensionRunner.emit(
      runner,
      { type: "session_before_compact", sessionID: input.sessionID, signal: input.abort } as Extension.SessionBeforeCompactEvent,
      compactCtx,
    )
    if ((beforeResult as Extension.SessionBeforeCompactResult)?.cancel) {
      log.info("compaction cancelled by extension")
      return "cancelled"
    }

    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)?.info as MessageV2.User | undefined
    if (!userMessage) {
      log.error("parent message not found for compaction", { parentID: input.parentID })
      return "stop"
    }
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await resolveTaskModel("compact", () => Provider.getModel(userMessage.model.providerID, userMessage.model.modelID))
    if (!model) {
      log.error("no model available for compaction", { agent: agent.model, userModel: userMessage.model })
      return "stop"
    }

    const cfg = await Config.get()
    const strategy = cfg.compaction?.strategy ?? "hybrid"
    const keepRecent = cfg.compaction?.keepRecent ?? 4
    const maxToolResults = cfg.compaction?.maxToolResults ?? CompactionExtractor.DEFAULT_MAX_TOOL_RESULTS

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant

    const defaultPrompt =
      "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
    const compactResult = beforeResult as Extension.SessionBeforeCompactResult | undefined
    const promptText = compactResult?.prompt ?? [defaultPrompt, ...(compactResult?.context ?? [])].join("\n\n")

    let result: "continue" | "stop" = "continue"

    if (strategy === "algorithmic") {
      log.info("algorithmic compaction")
      const state = CompactionExtractor.extract(input.messages, { maxToolResults })
      const summary = CompactionExtractor.serialize(state)
      if (summary.trim().length < 50) {
        log.info("algorithmic summary too short, aborting")
        return "stop"
      }
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: input.sessionID,
        type: "text",
        text: summary,
        time: { start: Date.now(), end: Date.now() },
      })
      msg.finish = "stop"
      msg.time.completed = Date.now()
      await Session.updateMessage(msg)
      result = "continue"
    } else if (strategy === "hybrid") {
      log.info("hybrid compaction")
      const state = CompactionExtractor.extract(input.messages, { maxToolResults })
      const inventory = CompactionExtractor.serialize(state)
      const recentMessages = CompactionExtractor.extractRecentMessages(input.messages, keepRecent)
      const recentModelMessages = MessageV2.toModelMessage(recentMessages)
      const inventoryMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: `## Structured Inventory\n\n${inventory}` }],
      }
      const synthesisMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: promptText }],
      }
      const hybridAgent = { ...agent, prompt: PROMPT_COMPACTION_HYBRID }
      const processor = SessionProcessor.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        abort: input.abort,
      })
      result = await processor.process({
        user: userMessage,
        agent: hybridAgent,
        abort: input.abort,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [inventoryMessage, ...recentModelMessages, synthesisMessage],
        model,
      })
      if (processor.message.error) return "stop"
    } else {
      log.info("llm compaction")
      const processor = SessionProcessor.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
        abort: input.abort,
      })
      result = await processor.process({
        user: userMessage,
        agent,
        abort: input.abort,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...MessageV2.toModelMessage(input.messages),
          {
            role: "user",
            content: [
              {
                type: "text",
                text: promptText,
              },
            ],
          },
        ],
        model,
      })
      if (processor.message.error) return "stop"
    }

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (msg.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    await ExtensionRunner.emit(
      runner,
      { type: "session_compact", sessionID: input.sessionID, fromExtension: input.fromExtension ?? false } as Extension.SessionCompactEvent,
      compactCtx,
    )
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
      fromExtension: z.boolean().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        fromExtension: input.fromExtension ?? false,
      })
    },
  )
}
