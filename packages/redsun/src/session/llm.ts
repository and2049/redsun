import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { streamText, wrapLanguageModel, type ModelMessage, type StreamTextResult, type Tool, type ToolSet } from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { SystemPrompt } from "./system"
import { ToolRegistry } from "@/tool/registry"
import { Flag } from "@/flag/flag"
import { ExtensionRunner } from "../extension/runner"
import { ExtensionContext } from "../extension/context"
import type { Extension } from "../extension/types"
import { ContextOptimizer } from "./context-optimizer"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.REDSUN_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    assistantMessageID?: string
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export function shouldUseOpenAIResponsesContinuation(input: {
    enabled: unknown
    providerID: string
    store: unknown
    auth?: Auth.Info
  }) {
    return (
      input.enabled === "api-only" &&
      input.providerID === "openai" &&
      input.store !== false &&
      input.auth?.type !== "oauth"
    )
  }

  export function resolveRequestOptions(input: {
    model: Provider.Model
    agent: Pick<Agent.Info, "options">
    sessionID: string
    providerOptions?: Record<string, any>
    variant?: string
    small?: boolean
  }) {
    const variant = !input.small && input.variant ? input.model.variants?.[input.variant] : undefined
    return pipe(
      {},
      mergeDeep(ProviderTransform.options(input.model, input.sessionID, input.providerOptions)),
      input.small ? mergeDeep(ProviderTransform.smallOptions(input.model)) : mergeDeep({}),
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant ?? {}),
    )
  }

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg] = await Promise.all([Provider.getLanguage(input.model), Config.get()])

    const header = SystemPrompt.header(input.model.providerID)
    const joinedSystem = [
      // use agent prompt otherwise provider prompt
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      // any custom prompt passed into this call
      ...input.system,
      // any custom prompt from last user message
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n")

    const userPrompt = extractUserPrompt(input.messages)
    const extRunner = await ToolRegistry.getRunner()
    const extContext = ExtensionContext.forSession({
      mode: "rpc",
      sessionID: input.sessionID,
      agent: input.agent.name,
      projectTrusted: extRunner.projectTrusted,
      getSystemPrompt: () => joinedSystem,
      signal: input.abort,
    })
    const beforeResult = await ExtensionRunner.emit(
      extRunner,
      {
        type: "before_agent_start",
        prompt: userPrompt,
        systemPrompt: joinedSystem,
      } as Extension.BeforeAgentStartEvent,
      extContext,
    )
    const mutatedSystem = (beforeResult as Extension.BeforeAgentStartResult | undefined)?.systemPrompt ?? joinedSystem

    const volatileEnv = await SystemPrompt.environmentVolatile()
    const volatileSystem = volatileEnv.join("\n")
    const system = [
      ...header,
      mutatedSystem,
      ...(volatileSystem ? [volatileSystem] : []),
    ]
    const provider = await Provider.getProvider(input.model.providerID)
    const openaiAuth = input.model.providerID === "openai" ? await Auth.get("openai") : undefined
    const params = {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      options: resolveRequestOptions({
        model: input.model,
        agent: input.agent,
        sessionID: input.sessionID,
        providerOptions: provider.options,
        variant: input.user.model.variant,
        small: input.small,
      }),
    }

    l.info("params", {
      params,
    })

    const maxOutputTokens = ProviderTransform.maxOutputTokens(
      input.model.api.npm,
      params.options,
      input.model.limit.output,
      OUTPUT_TOKEN_MAX,
    )

    const tools = await resolveTools(input)

    const messages = ContextOptimizer.optimizeModelMessages(input.messages)
    const breakdown = ContextOptimizer.breakdown({ system, messages, tools })
    l.info("context breakdown", { breakdown })
    if (input.assistantMessageID) {
      await ContextOptimizer.writeBreakdown({
        sessionID: input.sessionID,
        messageID: input.assistantMessageID,
        breakdown,
      })
    }

    const contextResult = await ExtensionRunner.emit(
      extRunner,
      { type: "context", messages: [...system.map((x): ModelMessage => ({ role: "system" as const, content: x })), ...messages] } as Extension.ContextEvent,
      extContext,
    )
    const contextMessages = (contextResult as Extension.ContextEventResult | undefined)?.messages

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...input.model.headers,
      },
      maxRetries: input.retries ?? 0,
      messages: (contextMessages as ModelMessage[] | undefined) ?? [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                const continuation =
                  shouldUseOpenAIResponsesContinuation({
                    enabled: provider.options?.experimentalResponsesContinuation,
                    providerID: input.model.providerID,
                    store: args.params.providerOptions?.openai?.store,
                    auth: openaiAuth,
                  })
                    ? await ContextOptimizer.lastOpenAIResponse({
                        sessionID: input.sessionID,
                        providerID: input.model.providerID,
                        modelID: input.model.id,
                      })
                    : undefined
                if (continuation) {
                  args.params.providerOptions = mergeDeep(args.params.providerOptions ?? {}, {
                    openai: { previousResponseId: continuation },
                  })
                }
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, provider.options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: { isEnabled: cfg.experimental?.openTelemetry },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const enabled = pipe(
      input.agent.tools,
      mergeDeep(await ToolRegistry.enabled(input.agent)),
      mergeDeep(input.user.tools ?? {}),
    )
    for (const [key, value] of Object.entries(enabled)) {
      if (value === false) delete input.tools[key]
    }
    return input.tools
  }

  function extractUserPrompt(messages: ModelMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "user") continue
      if (typeof m.content === "string") return m.content
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join("\n")
      }
    }
    return ""
  }

}
