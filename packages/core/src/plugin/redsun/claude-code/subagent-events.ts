// REDSUN: projects a mirrored subagent's activity into a child session.
//
// This is v2's replacement for V1's `Session.updateMessage`/`updatePart` no-LLM
// authoring path: publishing the durable events the projector already
// understands leaves the child with exactly the message rows an ordinary
// assistant turn would have produced.
//
// Order is load-bearing, because the projector is a fold over parts:
//   - `step.started` creates the assistant row (and completes the previous one),
//     so nothing else projects until it lands.
//   - `text`/`reasoning` push an empty part on `*.started` and fill it on
//     `*.ended`.
//   - `tool.success` only applies to a part already in `running`, which is what
//     `tool.input.started` -> `input.ended` -> `called` puts it in.
export * as ClaudeCodeSubagentEvents from "./subagent-events.js"

import { Effect } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import { Money } from "@opencode-ai/schema/money"
import type { Bus } from "../../../bus.js"
import { SessionEvent } from "../../../session/event.js"
import { SessionMessage } from "../../../session/message.js"
import type { ClaudeCodeSubagents } from "./subagents.js"

/**
 * Claude Code bills a subagent inside the parent turn's usage, so attributing
 * cost or tokens to the child would double-count the same spend.
 */
const NO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export const one = (
  bus: Bus.Interface,
  model: Model.Ref,
  event: ClaudeCodeSubagents.ChildEvent,
): Effect.Effect<unknown> => {
  const sessionID = event.sessionID as never
  switch (event.kind) {
    case "execution-started":
      return bus.publish(SessionEvent.Execution.Started, { sessionID })
    case "execution-succeeded":
      return bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    case "synthetic":
      return bus.publish(SessionEvent.Synthetic, { sessionID, text: event.text })
    case "step-started":
      return bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make(event.messageID),
        agent: Agent.ID.make(event.agent),
        model,
      })
    case "step-ended":
      return bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make(event.messageID),
        finish: "stop",
        cost: Money.USD.zero,
        tokens: NO_TOKENS,
      })
    case "text": {
      const base = {
        sessionID,
        assistantMessageID: SessionMessage.ID.make(event.messageID),
        ordinal: event.ordinal,
      }
      return bus
        .publish(SessionEvent.Text.Started, base)
        .pipe(Effect.andThen(bus.publish(SessionEvent.Text.Ended, { ...base, text: event.text })))
    }
    case "reasoning": {
      const base = {
        sessionID,
        assistantMessageID: SessionMessage.ID.make(event.messageID),
        ordinal: event.ordinal,
      }
      return bus
        .publish(SessionEvent.Reasoning.Started, base)
        .pipe(Effect.andThen(bus.publish(SessionEvent.Reasoning.Ended, { ...base, text: event.text })))
    }
    case "tool-called": {
      const base = { sessionID, assistantMessageID: SessionMessage.ID.make(event.messageID), id: event.id }
      return bus.publish(SessionEvent.Tool.Input.Started, { ...base, name: event.name }).pipe(
        Effect.andThen(bus.publish(SessionEvent.Tool.Input.Ended, { ...base, text: JSON.stringify(event.input) })),
        // Claude Code ran the tool itself, exactly as on the parent's stream.
        Effect.andThen(bus.publish(SessionEvent.Tool.Called, { ...base, input: event.input, executed: true })),
      )
    }
    case "tool-result": {
      const base = { sessionID, assistantMessageID: SessionMessage.ID.make(event.messageID), id: event.id }
      // Tool.Success.content is a NonEmptyArray, so an empty tool output still
      // needs a placeholder rather than an empty list.
      const content = [{ type: "text" as const, text: event.text || "(no output)" }] as const
      if (event.failed)
        return bus.publish(SessionEvent.Tool.Failed, {
          ...base,
          error: { type: "tool.execution", message: event.text || "The tool failed." },
          content,
          executed: true,
        })
      return bus.publish(SessionEvent.Tool.Success, { ...base, content, executed: true })
    }
  }
}

export const publish = (
  bus: Bus.Interface,
  model: Model.Ref,
  events: readonly ClaudeCodeSubagents.ChildEvent[],
): Effect.Effect<void> => Effect.forEach(events, (event) => one(bus, model, event), { discard: true })
