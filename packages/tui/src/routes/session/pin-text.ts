import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"

export function messageText(message: SessionMessageInfo): string {
  if (message.type === "user") return message.text
  if (message.type === "assistant")
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  return "text" in message ? message.text : ""
}

export function pinToolText(part: SessionMessageAssistantTool): string {
  const state = part.state
  const input = typeof state.input === "string" ? state.input : JSON.stringify(state.input, null, 2)
  const content = "content" in state ? (state.content ?? []) : []
  return [
    part.name,
    input,
    state.status === "error" ? state.error.message : "",
    ...content.map((item) => (item.type === "text" ? item.text : (item.name ?? item.mime))),
  ]
    .filter(Boolean)
    .join("\n")
}
