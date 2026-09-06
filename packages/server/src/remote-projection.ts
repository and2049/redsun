import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Array as Arr, Effect, Option } from "effect"
import { RemoteService } from "./remote-control"
import { SessionInbox } from "@opencode-ai/schema/session-inbox"
import { Permission } from "@opencode-ai/schema/permission"
import { Form } from "@opencode-ai/schema/form"

export const isRemote = Effect.serviceOption(RemoteService.Principal).pipe(Effect.map(Option.isSome))
export const project = <A>(value: A, transform: (value: A) => A) =>
  isRemote.pipe(Effect.map((remote) => (remote ? transform(value) : value)))

export function user(value: SessionInbox.User): SessionInbox.User {
  return {
    id: value.id,
    sessionID: value.sessionID,
    timeCreated: value.timeCreated,
    type: value.type,
    delivery: value.delivery,
    payload: { text: value.payload.text },
  }
}

export function inbox(value: SessionInbox.Info): SessionInbox.Info {
  const base = { id: value.id, sessionID: value.sessionID, timeCreated: value.timeCreated, delivery: value.delivery }
  switch (value.type) {
    case "user":
      return user(value)
    case "synthetic":
      return {
        ...base,
        type: value.type,
        payload: { text: value.payload.text, description: value.payload.description },
      }
    case "compaction":
      return { ...base, type: value.type, payload: {} }
    case "move":
      return {
        ...base,
        type: value.type,
        payload: {
          location: value.payload.location,
          projectID: value.payload.projectID,
          subpath: value.payload.subpath,
        },
      }
  }
  throw new Error("Unsupported remote inbox type")
}

export function permission(value: Permission.Request): Permission.Request {
  return {
    id: value.id,
    sessionID: value.sessionID,
    action: value.action,
    resources: value.resources,
    save: value.save,
    source: value.source,
    message: value.message,
  }
}

export function form(value: Form.Info): Form.Info {
  return { id: value.id, sessionID: value.sessionID, title: value.title, fields: value.fields }
}

export function formAllowed(value: Form.Info) {
  return value.fields.every((field) => ["string", "number", "integer", "boolean", "multiselect"].includes(field.type))
}

export function session(value: Session.Info): Session.Info {
  return {
    id: value.id,
    parentID: value.parentID,
    projectID: value.projectID,
    agent: value.agent,
    model: value.model,
    cost: value.cost,
    tokens: value.tokens,
    outcome: value.outcome,
    time: value.time,
    title: value.title,
    location: value.location,
    subpath: value.subpath,
  }
}

export function message(value: SessionMessage.Info): SessionMessage.Info {
  const base = { id: value.id, time: value.time }
  switch (value.type) {
    case "assistant":
      return {
        ...base,
        type: value.type,
        agent: value.agent,
        model: value.model,
        cost: value.cost,
        tokens: value.tokens,
        finish: value.finish,
        error: value.error
          ? { type: "remote", message: "Agent execution failed; details available locally" }
          : undefined,
        content: value.content.map((part): SessionMessage.AssistantContent => {
          if (part.type !== "tool") return { type: part.type, text: part.text }
          const state = part.state
          const safe: SessionMessage.ToolState =
            state.status === "streaming"
              ? { status: state.status, input: state.input }
              : state.status === "running"
                ? { status: state.status, input: state.input, metadata: {} }
                : state.status === "error"
                  ? {
                      status: state.status,
                      input: state.input,
                      error: { type: "remote", message: "Tool failed; details available locally" },
                    }
                  : {
                      status: state.status,
                      input: state.input,
                      content: Arr.map(state.content, (item) =>
                        item.type === "text"
                          ? { type: "text", text: item.text }
                          : { type: "text", text: "File output available locally" },
                      ),
                    }
          return { type: "tool", id: part.id, name: part.name, state: safe, time: part.time, executed: part.executed }
        }),
      }
    case "user":
      return { ...base, type: value.type, text: value.text }
    case "synthetic":
      return { ...base, type: value.type, text: value.text, description: value.description }
    case "system":
      return { ...base, type: value.type, text: "System context updated; details available locally" }
    case "skill":
      return {
        ...base,
        type: value.type,
        skill: value.skill,
        name: value.name,
        text: "Skill instructions available locally",
      }
    case "shell":
      return {
        ...base,
        type: value.type,
        shellID: value.shellID,
        command: value.command,
        status: value.status,
        exit: value.exit,
        output: value.output,
      }
    case "agent-switched":
      return { ...base, type: value.type, agent: value.agent, previous: value.previous }
    case "model-switched":
      return { ...base, type: value.type, model: value.model, previous: value.previous }
    case "location-switched":
      return {
        ...base,
        type: value.type,
        location: value.location,
        projectID: value.projectID,
        subpath: value.subpath,
        previous: value.previous,
      }
    case "compaction":
      return value.status === "failed"
        ? {
            ...base,
            type: value.type,
            status: value.status,
            reason: value.reason,
            error: { type: "remote", message: "Compaction failed" },
          }
        : {
            ...base,
            type: value.type,
            status: value.status,
            reason: value.reason,
            summary: value.summary,
            recent: value.recent,
          }
  }
  throw new Error("Unsupported remote message type")
}

export * as RemoteProjection from "./remote-projection"
