import { directory, json, worktree, type FetchHandler } from "../../test/fixture/tui-client"

// The transcript settles once this line is on screen; render.ts waits for it.
export const SESSION_MARKER = "Add dark pairs for the cloud and wave themes"

const location = { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } }

// Agent/model/provider catalog shown in the prompt footer:
// "Build · DeepSeek V4 Flash Free OpenCode Zen · high".
const model = { providerID: "opencode", id: "deepseek-v4-flash-free", variant: "high" }

const catalog: FetchHandler = (url, request) => {
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        {
          id: "build",
          name: "Build",
          mode: "primary",
          hidden: false,
          request: {},
          permissions: {},
        },
      ],
    })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: model.id,
          modelID: model.id,
          providerID: model.providerID,
          name: "DeepSeek V4 Flash Free",
          capabilities: {},
          variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
          time: { released: 1_700_000_000 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
      ],
    })
  if (url.pathname === "/api/provider")
    return json({
      location,
      data: [{ id: model.providerID, name: "OpenCode Zen", activation: "enabled", package: "opencode" }],
    })
  // Auto-approve all enabled.
  if (url.pathname === "/api/permission/mode" && request.method === "GET") return json({ data: { mode: "auto" } })
  return undefined
}

export function homeFixture(): FetchHandler {
  return catalog
}

export function sessionFixture(): FetchHandler {
  const session = {
    id: "preview",
    title: "Theme preview session",
    projectID: "proj_test",
    location,
    agent: "build",
    model,
    cost: 0.42,
    tokens: { input: 12_400, output: 2_210, reasoning: 380, cache: { read: 9_800, write: 1_200 } },
    time: { created: 1_000, updated: 60_000 },
  }
  const messages = [
    {
      type: "user",
      id: "user-1",
      text: SESSION_MARKER,
      time: { created: 1_000 },
    },
    {
      type: "assistant",
      id: "assistant-1",
      agent: "build",
      model: { id: model.id, providerID: model.providerID },
      finish: "stop",
      time: { created: 2_000, completed: 20_000 },
      cost: 0.31,
      tokens: { input: 12_400, output: 2_210, reasoning: 380, cache: { read: 9_800, write: 1_200 } },
      content: [
        {
          type: "reasoning",
          text: "The registry keeps one JSON asset per theme, so a dark pair is a sibling file plus two wiring entries.",
        },
        {
          type: "tool",
          id: "tool-1",
          name: "grep",
          state: {
            status: "completed",
            input: { pattern: "DEFAULT_THEMES", path: "packages/tui" },
            content: [{ type: "text", text: "3 matches" }],
          },
          time: { created: 3_000, completed: 4_000 },
        },
        {
          type: "text",
          text: "The registry lives in `packages/tui/src/theme/index.ts`. I will add **nimbus** and **tide** next to their light pairs.",
        },
      ],
    },
    {
      type: "assistant",
      id: "assistant-2",
      agent: "build",
      model: { id: model.id, providerID: model.providerID },
      time: { created: 21_000 },
      content: [
        // Streaming state renders the pending row with the live spinner.
        { type: "tool", id: "tool-2", name: "edit", state: { status: "streaming", input: "" }, time: { created: 21_000 } },
      ],
    },
  ]
  return (url, request) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/preview") return json({ data: session })
    // The client requests order:"desc" and reverses, so serve newest first.
    if (url.pathname === "/api/session/preview/message") return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === "/api/session/preview/inbox") return json({ data: [] })
    if (url.pathname === "/api/session/preview/permission") return json({ data: [] })
    // Mark the session as working so the prompt footer shows the trail spinner
    // and the interrupt hint.
    if (url.pathname === "/api/session/active") return json({ data: { preview: {} } })
    return catalog(url, request)
  }
}
