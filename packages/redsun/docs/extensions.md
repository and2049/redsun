> redsun can create extensions to add custom tools, commands, event handlers, providers, and more. Ask it to build one for your use case.

# Extensions

Extensions allow you to extend redsun with custom tools, commands, event lifecycle hooks, custom providers, and persistent state. You write TypeScript files in `.redsun/extensions/` and redsun loads them on startup and after reload.

## Quick Start

Create a file at `.redsun/extensions/hello.ts`:

```ts
// An extension receives an `api` object with all registration methods
export default async function(api) {
  // Register a tool the LLM can call
  await api.registerTool({
    id: "greet",
    init: async () => ({
      description: "Greet a person by name",
      parameters: z.object({
        name: z.string().describe("The name of the person to greet"),
      }),
      execute: async (args, ctx) => ({
        title: `Hello ${args.name}`,
        output: `Hello, ${args.name}! Greetings from a redsun extension.`,
        metadata: {},
      }),
      promptGuidelines: [
        "Use greet when you want to greet someone by name.",
      ],
    }),
  })

  // Register a slash command the user can type
  api.registerCommand({
    name: "hello",
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello from extension! ${args}`)
    },
  })

  // Listen for lifecycle events
  api.on("session_start", async (event, ctx) => {
    ctx.ui.notify("Extension loaded!")
  })
}
```

Then reload the runtime (use the `reload` tool or type `/reload`).

## Where Extensions Live

Extensions are loaded from these directories (searched in order):

| Location | Scope | Purpose |
|----------|-------|---------|
| `~/.redsun/extensions/` | User | Personal extensions available across all projects |
| `<config dir>/extensions/` | Config | Extensions from redsun config directories |
| `.redsun/extensions/` | Project | Project-specific extensions |

Additionally, extensions can be installed from npm or git via `redsun extension install <source>`.

## Available Imports

Extensions can import from:

- **`zod`** — Schema validation (automatically available, no install needed)
- **`path`, `os`, `fs`, `child_process`** — Node.js built-ins
- **Bun APIs** — `Bun.file()`, `Bun.write()`, `Bun.$.spawn()`, etc.

> **Important**: You cannot import internal redsun modules (like `Tool`, `Session`, etc.) from extension files. Extension tools must be defined inline using the `{ id, init }` object format shown in the examples below. The `z` (Zod) global is available for schema definitions.

## Extension File Format

An extension file has a default export that is an async factory function receiving the `api` object:

```ts
export default async function(api) {
  // Register tools, commands, event handlers here
}
```

The factory is called on startup and after each reload. Use it to set up all registrations.

> **After reload**, the old `api` object and all handler closures are invalidated. Any attempt to use a stale `api` object will throw an error. Your extension's factory function will be called again with a fresh `api` — simply re-register everything in the factory and it will work correctly.

For complex extensions, create a directory with an `index.ts` as the entry point. For npm packages, the `main` field in `package.json` points to the entry file.

## API Reference

The `api` object passed to your factory has the following methods:

### `api.on(event, handler)`

Register a handler for lifecycle events. Returns nothing.

```ts
api.on("tool_call", async (event, ctx) => {
  if (event.toolName === "write") {
    // Inspect or block tool calls
  }
})
```

See the Event Reference section below for all available event types.

### `api.registerTool(tool)`

Register a tool that the LLM can invoke. Tools must be defined as inline `Tool.Info` objects:

```ts
const myTool = {
  id: "my_tool",
  init: async (ctx) => ({
    description: "Description shown to the LLM",
    parameters: z.object({
      // Zod schema for tool arguments
      input: z.string().describe("Input parameter"),
    }),
    execute: async (args, ctx) => {
      // args is typed from the Zod schema
      // ctx provides sessionID, messageID, agent, abort, metadata()
      return {
        title: "Result title shown in UI",
        output: "Text output returned to the LLM",
        metadata: { key: "value" }, // arbitrary metadata
        attachments: [], // optional file attachments
      }
    },
    promptGuidelines: [
      "Hint to the LLM about when and how to use this tool.",
    ],
    formatValidationError: (error) => {
      return "Custom validation error message for the LLM."
    },
  }),
}

await api.registerTool(myTool)
```

**Note**: You must provide the complete `{ id, init }` object inline in extension files. You cannot import `Tool.define` or other redsun internals from within extensions — use the inline format shown above.

**Tool Context (`ctx`)**:

| Field | Type | Description |
|-------|------|-------------|
| `sessionID` | `string` | Current session ID |
| `messageID` | `string` | ID of the assistant message making the tool call |
| `agent` | `string` | Current agent name |
| `abort` | `AbortSignal` | Signal aborted when user cancels or session ends |
| `callID` | `string` (optional) | Unique ID for this tool call |
| `extra` | `object` (optional) | Additional context from the runtime |
| `metadata(input)` | `function` | Update tool execution metadata during execution |

### `api.unregisterTool(id)`

Remove a previously registered tool by its ID.

```ts
api.unregisterTool("my_tool")
```

### `api.registerCommand(command)`

Register a slash command that users can type:

```ts
api.registerCommand({
  name: "my-command",
  description: "Description shown in command list",
  handler: async (args, ctx) => {
    // args: string — everything after the command name
    // ctx: CommandContext
    ctx.ui.notify(`Executing with args: ${args}`)
  },
})
```

### `api.unregisterCommand(name)`

Remove a previously registered command.

### `api.sendMessage(content)`

Send a message that is displayed to the user but not processed by the agent. Useful for status updates.

```ts
api.sendMessage("Extension completed its task.")
```

Messages are persisted as `custom_message` entries in the session and injected into the LLM context chronologically.

### `api.sendUserMessage(content)`

Send a message that triggers the agent loop. The message is treated as user input and the agent will respond.

```ts
api.sendUserMessage("Please review the generated output.")
```

### `api.appendEntry(sessionID, customType, data?)`

Store persistent data in the session. Returns the entry ID.

```ts
const entryId = await api.appendEntry(sessionID, "my_extension_state", {
  lastProcessed: Date.now(),
  items: ["a", "b", "c"],
})
```

Custom entries (`type: "custom"`) persist across turns and survive compaction. Use `ctx.getEntries()` to read them back.

### `api.appendCustomMessageEntry(sessionID, customType, content, display?, details?)`

Add a custom message that is injected into the LLM's context. Think of it as the extension "speaking" to the agent.

```ts
await api.appendCustomMessageEntry(sessionID, "system_notice", "The CI build has completed.", true)
```

Custom message entries (`type: "custom_message"`) are injected chronologically into the message stream sent to the LLM. Use `display: true` to also show them in the UI.

### `api.setModel(model)`

Change the current session's model. The model specifier follows provider format like `"anthropic:claude-sonnet-4-20250514"`.

```ts
const success = await api.setModel("openai:gpt-4o")
```

Returns `true` if the model was found and set.

### `api.setActiveTools(toolNames)`

Set which tools are active for the session. Overwrites the active tool set.

```ts
api.setActiveTools(["read", "write", "bash", "my_tool"])
```

Use `api.getAllTools()` first to see what's available, then filter the list.

### `api.getActiveTools()`

Get the current list of active tool IDs.

### `api.getAllTools()`

Get all registered tools with their descriptions and source info.

### `api.registerProvider(name, config)`

Register a custom LLM provider:

```ts
api.registerProvider("my-provider", {
  name: "My Custom Provider",
  baseUrl: "https://api.example.com/v1",
  apiKey: process.env.MY_API_KEY,
  api: "openai", // API compatibility mode
  models: [{
    id: "my-model",
    name: "My Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }],
  headers: { "X-Custom": "value" },
})
```

### `api.unregisterProvider(name)`

Remove a previously registered provider.

### `api.events`

A simple pub/sub event bus for communication between extensions:

```ts
// Publish
api.events.emit("my_channel", { data: 42 })

// Subscribe
const unsubscribe = api.events.on("my_channel", (data) => {
  console.log("Received:", data)
})

// Unsubscribe when done
unsubscribe()
```

## Event Reference

Register handlers with `api.on(eventType, handler)`.

### Lifecycle Events

| Event | When | Handler Signature |
|-------|------|-------------------|
| `session_start` | Session is created or reloaded | `(event: { type, reason }, ctx) => void` |
| `session_shutdown` | Session is shutting down (quit, reload, session switch) | `(event: { type, reason }, ctx) => void` |
| `turn_start` | Agent begins a new turn | `(event: { type, turnIndex }, ctx) => void` |
| `turn_end` | Agent finishes a turn | `(event: { type, turnIndex }, ctx) => void` |

### Tool Interception

| Event | When | Handler Signature |
|-------|------|-------------------|
| `tool_call` | Before a tool executes | `(event: { type, toolCallId, toolName, input }, ctx) => { block?: boolean, reason?: string } \| undefined` |
| `tool_result` | After a tool completes | `(event: { type, toolCallId, toolName, input, output, metadata, isError }, ctx) => { output?, metadata?, isError? } \| undefined` |

To block a tool, return `{ block: true, reason: "..." }` from the `tool_call` handler. To modify the output, return `{ output: "new output" }` from the `tool_result` handler.

### User Input Interception

| Event | When | Handler Signature |
|-------|------|-------------------|
| `input` | User sends input (prompt, command, bash) | `(event: { type, text }, ctx) => { action?: "continue" \| "handled" \| "transform", text?: string }` |

- Return `{ action: "handled" }` to prevent normal processing.
- Return `{ action: "transform", text: "new text" }` to replace the input text.

### Provider / Agent

| Event | When | Handler Signature |
|-------|------|-------------------|
| `before_agent_start` | Before the LLM stream begins | `(event: { type, prompt, systemPrompt }, ctx) => { systemPrompt?: string } \| undefined` |
| `context` | Messages are being prepared for the LLM | `(event: { type, messages }, ctx) => { messages?: unknown[] } \| undefined` |
| `resources_discover` | Extension loading completes (startup or reload) | `(event: { type, cwd, reason }, ctx) => { skillPaths?, promptPaths?, themePaths? } \| undefined` |
| `agents_register` | Extension loading completes (startup or reload) | `(event: { type, cwd, reason }, ctx) => { agentPaths? } \| undefined` |

Use `resources_discover` to contribute skill paths, prompt template paths, and theme paths.
Use `agents_register` to contribute custom agent definitions.

### Session Management

| Event | When | Handler Signature |
|-------|------|-------------------|
| `session_before_compact` | Before context compaction begins | `(event: { type, sessionID, signal }, ctx) => { cancel?: boolean } \| undefined` |
| `session_compact` | After compaction completes | `(event: { type, sessionID, fromExtension }, ctx) => void` |
| `session_before_switch` | Before switching to a different session | `(event: { type, reason, targetSessionFile? }, ctx) => { cancel?: boolean } \| undefined` |
| `session_before_fork` | Before forking a session | `(event: { type, entryId, position }, ctx) => { cancel?: boolean } \| undefined` |

Return `{ cancel: true }` to block compaction, session switch, or fork.

### Project Trust

| Event | When | Handler Signature |
|-------|------|-------------------|
| `project_trust` | Resolving trust for a project directory | `(event: { type, cwd }, ctx: ProjectTrustContext) => { trusted: "yes" \| "no" \| "undecided", remember?: boolean } \| undefined` |

This event fires when redsun needs to determine if a project directory is trusted. Extensions can vote on trust decisions.

## Extension Context

### Base Context (`Extension.Context`)

The `ctx` object passed to event handlers (not command handlers):

| Property | Type | Description |
|----------|------|-------------|
| `ui` | `UIContext` | UI interaction methods. `notify()` logs a message; `confirm()`, `input()`, `select()` are stubs (not yet wired to TUI — always return `false`/`undefined`) |
| `mode` | `"tui" \| "print" \| "rpc"` | Current interaction mode |
| `hasUI` | `boolean` | Whether UI interactions are available |
| `cwd` | `string` | Current working directory |
| `sessionID` | `string` | Current session ID |
| `agent` | `string` | Current agent name |
| `isIdle()` | `() => boolean` | Whether the session is idle (not processing) |
| `isProjectTrusted()` | `() => boolean` | Whether the current project is trusted |
| `signal` | `AbortSignal \| undefined` | Abort signal for the current operation |
| `abort()` | `() => void` | Abort the current operation |
| `hasPendingMessages()` | `() => boolean` | Whether the session is currently processing (busy status) |
| `getContextUsage()` | `() => ContextUsage \| undefined` | Current context window usage |
| `getSystemPrompt()` | `() => string` | Current system prompt content |
| `getEntries<T>(customType)` | `(type: string) => Promise<Array>` | Read persisted entries by custom type |
| `compact()` | `() => Promise<void>` | Trigger context compaction |

> **Session-scoped context**: `api.sendMessage()` and `api.sendUserMessage()` only work during session-scoped events (e.g., `session_start`, `tool_call`, `tool_result`, `turn_start`, `turn_end`, `input`). They will silently fail during startup events like `resources_discover` and `agents_register` which have no session context.

### Command Context (`Extension.CommandContext`)

Extends base context. The `ctx` passed to command handlers adds:

| Property | Type | Description |
|----------|------|-------------|
| `reload()` | `() => Promise<void>` | Reload the runtime (re-scans extensions from disk) |
| `newSession(options?)` | `(opts?) => Promise<{ sessionID }>` | Create a new session. Optional `parentSession` for forking |
| `fork(entryId)` | `(entryId: string) => Promise<{ sessionID }>` | Fork from a specific session entry |

**Important**: `Extension.CommandContext` is only available in command handlers registered via `api.registerCommand()`. Event handlers receive base `Extension.Context`.

## State Persistence

Extensions persist data using entries. There are two entry types:

### Custom Entries (persistent state)

```ts
// Write
const entryId = await api.appendEntry(ctx.sessionID, "my_state", {
  counter: 42,
  items: ["a", "b"],
})

// Read
const entries = await ctx.getEntries<{ counter: number; items: string[] }>("my_state")
const latest = entries[entries.length - 1]
```

Custom entries survive compaction and persist for the lifetime of the session.

### Custom Message Entries (LLM-visible messages)

```ts
// The agent sees this as a user message in its context
await api.appendCustomMessageEntry(ctx.sessionID, "notice", "The file analysis is complete.", true)
```

These are injected chronologically into the LLM's message context and are logically filtered by compaction (entries before the compaction boundary are excluded).

## Reloading

After writing new extension files or modifying existing ones, trigger a reload to pick up the changes:

1. **Tool**: Use the `reload` tool — it queues a reload after the current turn completes
2. **Command**: Type `/reload` in the chat
3. **Programmatic**: Call `ctx.reload()` from a command handler

On reload:
1. `session_shutdown` fires — extensions can clean up
2. All extension files are re-scanned and re-loaded from disk
3. New `ExtensionRunner` is created with fresh handlers
4. `session_start` fires — extensions re-initialize
5. `resources_discover` and `agents_register` fire for the new runner

All registrations from the old runner are discarded — extensions must re-register in their factory.

## Complete Examples

### Example 1: File Watcher Extension

```ts
// .redsun/extensions/file-watcher.ts
export default async function(api) {
  const watchedFiles = new Map()

  api.registerTool({
    id: "watch_file",
    init: async () => ({
      description: "Watch a file for changes and report modifications",
      parameters: z.object({
        filePath: z.string().describe("Path to the file to watch"),
      }),
      execute: async (args, ctx) => {
        const path = args.filePath
        watchedFiles.set(path, Date.now())

        await api.appendCustomMessageEntry(
          ctx.sessionID,
          "file_watch",
          `Now watching: ${path}`,
          true,
        )

        return {
          title: `Watching ${path}`,
          output: `Started watching ${path} for changes.`,
          metadata: {},
        }
      },
      promptGuidelines: [
        "Use watch_file to monitor files for external changes.",
      ],
    }),
  })

  api.on("turn_start", async (event, ctx) => {
    for (const [path, lastSeen] of watchedFiles) {
      const stat = await fs.promises.stat(path).catch(() => null)
      if (stat && stat.mtimeMs > lastSeen) {
        watchedFiles.set(path, stat.mtimeMs)
        await api.appendCustomMessageEntry(
          ctx.sessionID,
          "file_change",
          `File changed externally: ${path}`,
          true,
        )
      }
    }
  })
}
```

### Example 2: Custom Restart Command

```ts
// .redsun/extensions/restart.ts
import { spawn } from "child_process"

export default async function(api) {
  api.registerCommand({
    name: "restart-server",
    description: "Restart the development server",
    handler: async (args, ctx) => {
      ctx.ui.notify("Restarting server...")

      const proc = spawn("npm", ["run", "dev"], {
        cwd: ctx.cwd,
        stdio: "pipe",
      })

      proc.stdout.on("data", (data) => {
        api.sendMessage(`Server output: ${data}`)
      })

      proc.stderr.on("data", (data) => {
        api.sendMessage(`Server error: ${data}`)
      })

      ctx.ui.notify("Server restarted!")
    },
  })
}
```

### Example 3: Tool Call Logger

```ts
// .redsun/extensions/tool-logger.ts
export default async function(api) {
  const callLog: Array<{ tool: string; time: number; blocked: boolean }> = []

  api.on("tool_call", async (event, ctx) => {
    callLog.push({
      tool: event.toolName,
      time: Date.now(),
      blocked: false,
    })
    api.sendMessage(`Tool called: ${event.toolName}`)
  })

  api.on("tool_result", async (event, ctx) => {
    const entry = callLog[callLog.length - 1]
    if (entry?.tool === event.toolName) {
      api.sendMessage(`Tool completed: ${event.toolName}`)
    }
  })
}
```

### Example 4: Block Dangerous Commands

```ts
// .redsun/extensions/guard.ts
export default async function(api) {
  const BLOCKED_COMMANDS = ["rm -rf /", "git push --force origin main"]

  api.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined

    const command = event.input.command as string
    if (BLOCKED_COMMANDS.some(c => command.includes(c))) {
      return {
        block: true,
        reason: `Command "${command}" is blocked by the guard extension.`,
      }
    }
    return undefined
  })
}
```
