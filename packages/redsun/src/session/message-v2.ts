import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { NamedError } from "@redsun/util/error"
import { Message } from "./message"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Identifier } from "../id/id"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { fn } from "@/util/fn"
import { Storage } from "@/storage/storage"
import { ProviderTransform } from "@/provider/transform"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { type SystemError } from "bun"
import { Entry } from "../entry/entry"
import { ContextOptimizer } from "./context-optimizer"
import type { Provider } from "../provider/provider"

interface FetchDecompressionError extends Error {
  code: "ZlibError"
}

export namespace MessageV2 {
  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const ContextOverflowError = NamedError.create(
    "ContextOverflowError",
    z.object({ message: z.string(), responseBody: z.string().optional() }),
  )
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const ContentFilterError = NamedError.create("ContentFilterError", z.object({ message: z.string() }))
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    fromExtension: z.boolean().optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    command: z.string().optional(),
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      modelOutput: z.string().optional(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
      variant: z.string().optional(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        ContextOverflowError.Schema,
        AbortedError.Schema,
        ContentFilterError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  function customMessageToModelMessage(entry: Entry.CustomMessageEntry): ModelMessage {
    const text = typeof entry.content === "string"
      ? entry.content
      : entry.content.map((p) => p.text).join("\n")
    const tagged = ContextOptimizer.boundText(`custom message ${entry.customType}`, `[custom:${entry.customType}] ${text}`)
    return {
      role: "user",
      content: [{ type: "text", text: tagged }],
    }
  }

  export async function toModelMessageWithCustom(
    sessionID: string,
    messages: WithParts[],
    compactionCutoff?: number,
    model?: Provider.Model,
  ): Promise<ModelMessage[]> {
    const entries = await Entry.list(sessionID)
    let customMessages = entries.filter((e): e is Entry.CustomMessageEntry => e.type === "custom_message")

    if (compactionCutoff !== undefined) {
      customMessages = customMessages.filter((e) => e.timestamp >= compactionCutoff)
    }

    const sortedCustom = [...customMessages].sort((a, b) => a.timestamp - b.timestamp)
    const result: ModelMessage[] = []
    let customIdx = 0

    for (const msg of messages) {
      while (customIdx < sortedCustom.length && sortedCustom[customIdx].timestamp <= msg.info.time.created) {
        result.push(customMessageToModelMessage(sortedCustom[customIdx]))
        customIdx++
      }

      result.push(...toModelMessage([msg], model))
    }

    while (customIdx < sortedCustom.length) {
      result.push(customMessageToModelMessage(sortedCustom[customIdx]))
      customIdx++
    }

    return result
  }

  export function toModelMessage(input: WithParts[], model?: Provider.Model): ModelMessage[] {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()

    const supportsMediaInToolResult = (attachment: { mime: string }) => {
      if (!model) return false
      if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/openai") return true
      if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
      if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
      if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
      if (model.api.npm === "@ai-sdk/google") {
        const id = model.api.id.toLowerCase()
        return id.includes("gemini-3") && !id.includes("gemini-2")
      }
      return false
    }

    const toModelOutput = (output: unknown) => {
      if (typeof output === "string") return { type: "text" as const, value: output }
      if (typeof output === "object" && output !== null) {
        const value = output as { text?: string; attachments?: Array<{ mime: string; url: string }> }
        const attachments = (value.attachments ?? []).filter(
          (attachment) => attachment.url.startsWith("data:") && attachment.url.includes(","),
        )
        return {
          type: "content" as const,
          value: [
            ...(value.text ? [{ type: "text" as const, text: value.text }] : []),
            ...attachments.map((attachment) => ({
              type: "media" as const,
              mediaType: attachment.mime,
              data: attachment.url.slice(attachment.url.indexOf(",") + 1),
            })),
          ],
        }
      }
      return { type: "json" as const, value: output as never }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored && part.text !== "")
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory")
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
        if (userMessage.parts.length > 0) result.push(userMessage)
      }

      if (msg.info.role === "assistant") {
        const differentModel = !!model && `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
        const media: Array<{ mime: string; url: string; filename?: string }> = []
        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        const hasSignedReasoning = msg.parts.some(
          (part) =>
            part.type === "reasoning" &&
            (part.metadata?.anthropic?.signature != null || part.metadata?.bedrock?.signature != null),
        )
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text === "" && hasSignedReasoning ? " " : part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              const outputText = part.state.time.compacted
                ? "[Old tool result content cleared]"
                : part.state.modelOutput ?? part.state.output
              const attachments = part.state.time.compacted ? [] : (part.state.attachments ?? [])
              const extracted = attachments.filter(
                (attachment) =>
                  (attachment.mime.startsWith("image/") || attachment.mime === "application/pdf") &&
                  !supportsMediaInToolResult(attachment),
              )
              media.push(...extracted)
              const inline = attachments.filter((attachment) => !extracted.includes(attachment))
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                output: inline.length > 0 ? { text: outputText, attachments: inline } : outputText,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error") {
              const interrupted = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
              assistantMessage.parts.push(
                typeof interrupted === "string"
                  ? {
                      type: ("tool-" + part.tool) as `tool-${string}`,
                      state: "output-available",
                      toolCallId: part.callID,
                      input: part.state.input,
                      output: interrupted,
                      ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                      ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
                    }
                  : {
                      type: ("tool-" + part.tool) as `tool-${string}`,
                      state: "output-error",
                      toolCallId: part.callID,
                      input: part.state.input,
                      errorText: part.state.error,
                      ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                      ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
                    },
              )
            }
            if (part.state.status === "pending" || part.state.status === "running") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
          }
          if (part.type === "reasoning") {
            if (differentModel) {
              if (part.text.trim()) assistantMessage.parts.push({ type: "text", text: part.text })
              continue
            }
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              providerMetadata: part.metadata,
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
          if (media.length > 0) {
            result.push({
              id: Identifier.ascending("message"),
              role: "user",
              parts: [
                { type: "text", text: "Attached media from tool result:" },
                ...media.map((attachment) => ({
                  type: "file" as const,
                  url: attachment.url,
                  mediaType: attachment.mime,
                  filename: attachment.filename,
                })),
              ],
            })
          }
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((name) => [name, { toModelOutput }]))
    return convertToModelMessages(result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")), {
      tools: tools as any,
    })
  }

  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    for (let i = list.length - 1; i >= 0; i--) {
      yield await get({
        sessionID,
        messageID: list[i][2],
      })
    }
  })

  export function optimizePartForStorage(part: Part): Part {
    if (part.type !== "tool") return part
    if (part.state.status !== "completed") return part
    if (part.state.modelOutput !== undefined) return part

    const modelOutput = ContextOptimizer.modelToolOutput({
      partID: part.id,
      tool: part.tool,
      output: part.state.output,
    })
    if (!modelOutput) return part
    return {
      ...part,
      state: {
        ...part.state,
        modelOutput,
      },
    }
  }

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    const result = [] as MessageV2.Part[]
    for (const item of await Storage.list(["part", messageID])) {
      const read = await Storage.read<MessageV2.Part>(item)
      result.push(read)
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  })

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input) => {
      return {
        info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
        parts: await parts(input.messageID),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
        completed.add(msg.info.parentID)
      }
    }
    result.reverse()
    return result
  }

  export function fromError(e: unknown, ctx: { providerID: string; aborted?: boolean }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
        if (ctx.aborted) return new MessageV2.AbortedError({ message: e.message }, { cause: e }).toObject()
        return new MessageV2.APIError(
          {
            message: "Response decompression failed",
            isRetryable: true,
            metadata: { code: "ZlibError", message: e.message },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const message = iife(() => {
          let msg = e.message
          if (msg === "") {
            if (e.responseBody) return e.responseBody
            if (e.statusCode) {
              const err = STATUS_CODES[e.statusCode]
              if (err) return err
            }
            return "Unknown error"
          }
          const transformed = ProviderTransform.error(ctx.providerID, e)
          if (transformed !== msg) {
            return transformed
          }
          if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
            return msg
          }

          try {
            const body = JSON.parse(e.responseBody)
            // try to extract common error message fields
            const errMsg = body.message || body.error || body.error?.message
            if (errMsg && typeof errMsg === "string") {
              return `${msg}: ${errMsg}`
            }
          } catch {}

          return `${msg}: ${e.responseBody}`
        }).trim()

        const responseCode = (() => {
          try {
            return JSON.parse(e.responseBody ?? "null")?.error?.code
          } catch {
            return undefined
          }
        })()
        if (
          ProviderTransform.isContextOverflow(message) ||
          e.statusCode === 413 ||
          responseCode === "context_length_exceeded"
        ) {
          return new MessageV2.ContextOverflowError(
            { message, responseBody: e.responseBody },
            { cause: e },
          ).toObject()
        }

        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: ctx.providerID.startsWith("openai") && e.statusCode === 404 ? true : e.isRetryable,
            responseHeaders: e.responseHeaders,
            responseBody: e.responseBody,
            metadata: e.url ? { url: e.url } : undefined,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        try {
          const raw = typeof e === "string" ? JSON.parse(e) : e
          const body =
            raw && typeof raw === "object" && typeof (raw as any).message === "string"
              ? iife(() => {
                  try {
                    return JSON.parse((raw as any).message) ?? raw
                  } catch {
                    return raw
                  }
                })
              : raw
          if (body && typeof body === "object" && (body as any).type === "error") {
            const responseBody = JSON.stringify(body)
            const code = (body as any).error?.code
            const detail = (body as any).error?.message
            if (code === "context_length_exceeded") {
              return new MessageV2.ContextOverflowError(
                { message: "Input exceeds context window of this model", responseBody },
                { cause: e },
              ).toObject()
            }
            const mapped = {
              insufficient_quota: "Quota exceeded. Check your plan and billing details.",
              usage_not_included:
                "To use OpenAI through ChatGPT OAuth, upgrade to ChatGPT Plus: https://chatgpt.com/explore/plus.",
              invalid_prompt: typeof detail === "string" ? detail : "Invalid prompt.",
              server_is_overloaded: typeof detail === "string" ? detail : "Server error.",
              server_error: typeof detail === "string" ? detail : "Server error.",
            }[code as string]
            if (mapped) {
              return new MessageV2.APIError(
                {
                  message: mapped,
                  isRetryable: code === "server_is_overloaded" || code === "server_error",
                  responseBody,
                },
                { cause: e },
              ).toObject()
            }
          }
        } catch {}
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e })
    }
  }
}
