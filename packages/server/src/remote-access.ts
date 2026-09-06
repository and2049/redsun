import { Effect, Schema, FileSystem } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { RemoteControl } from "@opencode-ai/schema/remote-control"

const id = "ses_[A-Za-z0-9_-]+"
const reads = [
  /^\/api\/remote$/,
  /^\/api\/remote\/(agent|model)$/,
  /^\/api\/location$/,
  /^\/api\/session$/,
  /^\/api\/session\/active$/,
  /^\/api\/event$/,
  new RegExp(`^/api/session/${id}$`),
  new RegExp(`^/api/session/${id}/(message|inbox|permission|form)$`),
  new RegExp(`^/api/session/${id}/message/msg_[A-Za-z0-9_-]+$`),
  new RegExp(`^/api/session/${id}/form/frm_[A-Za-z0-9_-]+(/state)?$`),
  new RegExp(`^/api/session/${id}/permission/per_[A-Za-z0-9_-]+$`),
]
const mutations = [
  [/^\/api\/remote\/heartbeat$/, ["connected"]],
  [/^\/api\/session$/, ["id", "title", "agent", "model", "location"]],
  [new RegExp(`^/api/session/${id}/prompt$`), ["id", "text", "files", "delivery"]],
  [new RegExp(`^/api/session/${id}/move$`), ["directory", "workspaceID", "delivery"]],
  [new RegExp(`^/api/session/${id}/agent$`), ["agent"]],
  [new RegExp(`^/api/session/${id}/model$`), ["model"]],
  [new RegExp(`^/api/session/${id}/interrupt$`), []],
  [new RegExp(`^/api/session/${id}/permission/per_[A-Za-z0-9_-]+/reply$`), ["reply", "message"]],
  [new RegExp(`^/api/session/${id}/form/frm_[A-Za-z0-9_-]+/reply$`), ["answer"]],
  [new RegExp(`^/api/session/${id}/form/frm_[A-Za-z0-9_-]+/cancel$`), []],
] as const

const File = Schema.Struct({
  uri: Schema.String.check(Schema.isPattern(/^data:(text\/plain|image\/(png|jpeg|webp));base64,[A-Za-z0-9+/]*={0,2}$/)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
})
const Files = Schema.Array(File).check(Schema.isMaxLength(4))

export function route(method: string, pathname: string) {
  if (method === "GET") return reads.some((pattern) => pattern.test(pathname))
  return method === "POST" && mutations.some(([pattern]) => pattern.test(pathname))
}

export function payload(pathname: string, value: unknown) {
  const entry = mutations.find(([pattern]) => pattern.test(pathname))
  if (!entry || !Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value)) return false
  const body = value
  if (Object.keys(body).some((key) => !(entry[1] as readonly string[]).includes(key))) return false
  if (pathname.endsWith("/prompt")) {
    if (typeof body.id !== "string" || !/^msg_[A-Za-z0-9_-]+$/.test(body.id)) return false
    if (body.files !== undefined) {
      if (!Schema.is(Files)(body.files)) return false
      if (body.files.some((file) => Object.keys(file).some((key) => key !== "uri" && key !== "name"))) return false
    }
  }
  for (const [key, fields] of [
    ["location", ["directory", "workspaceID"]],
    ["model", ["id", "providerID", "variant"]],
  ] as const) {
    const nested = body[key]
    if (nested === undefined) continue
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return false
    if (Object.keys(nested).some((name) => !(fields as readonly string[]).includes(name))) return false
  }
  return true
}

export const check = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  if (!route(request.method, url.pathname)) return false
  const query =
    url.pathname === "/api/session" && request.method === "GET"
      ? ["workspace", "limit", "order", "search", "parentID", "directory", "project", "subpath", "cursor"]
      : url.pathname === "/api/location" || /^\/api\/remote\/(agent|model)$/.test(url.pathname)
        ? ["location[directory]", "location[workspace]"]
        : new RegExp(`^/api/session/${id}/message$`).test(url.pathname)
          ? ["limit", "order", "cursor"]
          : url.pathname.endsWith("/interrupt")
            ? ["continue"]
            : []
  if ([...url.searchParams.keys()].some((key) => !query.includes(key))) return false
  if (request.method === "GET") return true
  const text = yield* request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(6 * 1024 * 1024)),
    Effect.orElseSucceed(() => "invalid"),
  )
  if (Buffer.byteLength(text) > 6 * 1024 * 1024) return false
  return yield* Effect.try({
    try: () => payload(url.pathname, text === "" ? {} : JSON.parse(text)),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))
})

export * as RemoteAccess from "./remote-access"

export const events = new Set([
  "session.created",
  "session.deleted",
  "session.forked",
  "session.moved",
  "session.renamed",
  "session.agent.selected",
  "session.model.selected",
  "session.message.content.updated",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.compaction.ended",
  "session.synthetic",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "catalog.updated",
  "agent.updated",
])

export function eventFrame(frame: string) {
  const event: unknown = JSON.parse(frame.slice(6))
  if (typeof event !== "object" || event === null || !("type" in event) || typeof event.type !== "string") return ""
  if (!("id" in event) || typeof event.id !== "string") return ""
  const created = "created" in event && typeof event.created === "number" ? event.created : 0
  if (event.type === "server.connected")
    return `data: ${JSON.stringify({ id: event.id, type: "server.connected", data: {} })}\n\n`
  if (event.type === "remote.status") {
    if (!("data" in event)) return ""
    const value = Schema.decodeUnknownSync(RemoteControl.Status)(event.data)
    return `data: ${JSON.stringify({ id: event.id, created, type: "remote.status", data: value })}\n\n`
  }
  if (!events.has(event.type) || !("id" in event)) return ""
  return `data: ${JSON.stringify({ id: event.id, created, type: "remote.sync", data: {} })}\n\n`
}
