# Phase 5 — Extension State Persistence

**Goal:** Extensions can persist state across reloads and branch navigations, and inject persistent context into the LLM conversation.

This follows pi's architecture closely: two entry types — `CustomEntry` (state only, not in LLM context) and `CustomMessageEntry` (state + LLM context). Both are stored as separate records in Storage, queried by `customType`, and survive compaction.

---

## 5.1 Entry data model (`src/entry/entry.ts`)

Two Zod schemas stored as separate Storage records under `["entry", sessionID, entryID]`:

```ts
// CustomEntry — persisted state, NOT sent to LLM
export const CustomEntry = z.object({
  id: z.string(),
  sessionID: z.string(),
  type: z.literal("custom"),
  customType: z.string(),
  data: z.unknown().optional(),
  timestamp: z.number(),
})

// CustomMessageEntry — persisted AND sent to LLM as user context
export const CustomMessageEntry = z.object({
  id: z.string(),
  sessionID: z.string(),
  type: z.literal("custom_message"),
  customType: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))]),
  display: z.boolean(),
  details: z.unknown().optional(),
  timestamp: z.number(),
})

export const Entry = z.discriminatedUnion("type", [CustomEntry, CustomMessageEntry])
```

Design notes:
- Entries are **not parts** — they don't attach to messages. They're standalone records in the Storage layer, keyed by session.
- `customType` is an extension-defined string for filtering (e.g., `"my-extension-state"`).
- `data` on CustomEntry is opaque extension data, never sent to LLM.
- `content` on CustomMessageEntry is the text that gets injected into LLM context (string or structured text parts).
- `details` on CustomMessageEntry is extension metadata, not sent to LLM.
- `display` on CustomMessageEntry controls whether the TUI renders the entry visually.

---

## 5.2 Identifier prefix

Add `"entry": "ent"` to `Identifier.prefixes` in `src/id/id.ts`. Entry IDs look like `ent_<hex><random>`.

---

## 5.3 Entry namespace (`src/entry/entry.ts`)

```ts
export namespace Entry {
  append(sessionID: string, entry: CustomEntry | CustomMessageEntry): Promise<string>
  list(sessionID: string): Promise<Entry[]>
  getByType<T = unknown>(sessionID: string, customType: string): Promise<Array<CustomEntry & { data?: T }> | Array<CustomMessageEntry & { details?: T }>>
  remove(sessionID: string, entryID: string): Promise<void>
  removeAll(sessionID: string): Promise<void>
}
```

- `append` generates an ID via `Identifier.ascending("entry")`, sets `sessionID` and `timestamp`, writes to `Storage.write(["entry", sessionID, entry.id], entry)`, publishes `Entry.Event.Appended`, returns the entry ID.
- `list` reads all entries from `Storage.list(["entry", sessionID])` + `Storage.read`, sorted by `timestamp`.
- `getByType` filters `list` result by `customType`.
- `removeAll` called from `Session.remove` to clean up entries when a session is deleted.

---

## 5.4 Bus event

```ts
export const Event = {
  Appended: BusEvent.define("entry.appended", z.object({
    sessionID: z.string(),
    entryID: z.string(),
    customType: z.string(),
    type: z.enum(["custom", "custom_message"]),
  })),
}
```

---

## 5.5 Interface changes (`src/extension/types.ts`)

```ts
// Context.getEntries becomes async (was sync stub returning [])
getEntries<T = unknown>(customType: string): Promise<Array<{ customType: string; data?: T }>>

// API.appendEntry becomes async, returns entry ID (was sync no-op)
appendEntry<T = unknown>(customType: string, data?: T): Promise<string>

// New: API.appendCustomMessageEntry
appendCustomMessageEntry<T = unknown>(
  customType: string,
  content: string | Array<{ type: "text"; text: string }>,
  display?: boolean,
  details?: T,
): Promise<string>
```

---

## 5.6 Wire `appendEntry` and `appendCustomMessageEntry` in `src/tool/registry.ts`

Replace no-op stubs:

```ts
appendEntry: async (customType, data) => {
  return Entry.append(Instance.session, { type: "custom", customType, data, ... })
},
appendCustomMessageEntry: async (customType, content, display, details) => {
  return Entry.append(Instance.session, { type: "custom_message", customType, content, display: display ?? true, details, ... })
},
```

---

## 5.7 Wire `getEntries` in `src/extension/context.ts`

Replace `listEntriesSync` stub with async `Entry.getByType`:

```ts
getEntries: async <T>(customType: string) => {
  const entries = await Entry.getByType<T>(options.sessionID, customType)
  return entries.map(e => ({ customType: e.customType, data: e.data ?? e.details }))
},
```

---

## 5.8 LLM context injection for `custom_message` entries

### How pi does it

`custom_message` entries are converted to `AgentMessage` objects with `role: "custom"` and injected **inline in the message stream** at their chronological position during `buildSessionContext()`. In `convertToLlm()`, they become `role: "user"` messages. This means they appear in the conversation history at the point where they were appended — not as a separate section.

### Redsun adaptation

Redsun doesn't use a tree-based session model. Messages are flat records in Storage. The approach:

In `src/session/prompt.ts`, after `filterCompacted()` returns the message stream, load `custom_message` entries for the session via `Entry.list(sessionID)`, then inject them into the message array at their chronological position (sorted by `timestamp`). Convert each `custom_message` entry to a synthetic user message part.

Specifically, in `MessageV2.toModelMessage()` or in the prompt assembly in `prompt.ts`:

1. Load custom_message entries: `const entries = await Entry.list(sessionID)`
2. Filter to `type === "custom_message"`
3. For each entry, create a synthetic text part: `{ type: "text", text: entry.content }` (or use the structured content directly if it's an array)
4. Inject these at the correct chronological position among the message stream — since entries have `timestamp`, they can be interleaved with messages by timestamp

In `MessageV2.toModelMessage()`, each `custom_message` becomes:
```ts
{ role: "user", content: [{ type: "text", text: entry.content }] }
```

This follows pi's pattern: custom messages appear inline in the conversation at their timestamp position, just like user messages.

---

## 5.9 Compaction behavior

### How pi does it

- `custom` entries: **not cut points**, not in the message stream — they're metadata nodes that simply persist in the tree
- `custom_message` entries: **are cut points** (treated like user messages in compaction). They can be part of the `firstKeptEntryId` boundary. After compaction, custom_message entries after the boundary are preserved and appear in context.

### Redsun adaptation

- **Custom entries (type: "custom")** are not in the message stream at all — they survive compaction unchanged. No code changes needed.
- **Custom message entries (type: "custom_message")** are loaded from Entry storage each time context is built. Since they're injected after `filterCompacted()`, compaction filtering of messages doesn't remove them. They're always present in context regardless of compaction state.
- In `SessionCompaction.prune()`: custom_message entries are never pruned (they're short, typically just context injection, not large tool outputs).

This matches pi's behavior: custom_message entries after the compaction boundary are always present in the LLM context.

---

## 5.10 Session cleanup

In `Session.remove` (`src/session/index.ts`), add entry cleanup alongside message/part cleanup:

```ts
for (const entry of await Storage.list(["entry", sessionID])) {
  await Storage.remove(entry)
}
```

Or use `Entry.removeAll(sessionID)` which does the same.

---

## 5.11 Implementation order

| Step | File | Action | Description |
|---|---|---|---|
| 1 | `src/id/id.ts` | Modify | Add `"entry": "ent"` prefix |
| 2 | `src/entry/entry.ts` | Create | Zod schemas, namespace with append/list/getByType/remove/removeAll, Bus event |
| 3 | `src/entry/index.ts` | Create | Re-export |
| 4 | `src/extension/types.ts` | Modify | `getEntries` → async Promise, add `appendCustomMessageEntry` to API |
| 5 | `src/extension/context.ts` | Modify | Wire `getEntries` to `Entry.getByType`, async |
| 6 | `src/tool/registry.ts` | Modify | Wire `appendEntry` and `appendCustomMessageEntry` to `Entry.append` |
| 7 | `src/session/prompt.ts` | Modify | Load and inject `custom_message` entries into LLM context chronologically |
| 8 | `src/session/index.ts` | Modify | Add `Entry.removeAll(sessionID)` in `Session.remove` |
| 9 | `test/entry/entry.test.ts` | Create | Tests: append, list, getByType, remove, custom_message entries, entries survive across calls |
| 10 | `test/extension/context.test.ts` | Create/modify | Test `getEntries` returns real entries, `appendEntry` integration |
| 11 | `docs/extension-port-plan.md` | Modify | Update Phase 5 section with final design |

---

## Key Decisions

- **Entries are separate Storage records, not parts.** Pi uses a tree-based JSONL model where entries are nodes. Redsun uses per-record JSON files. Entries stored at `["entry", sessionID, entryID]` separate from messages/parts.
- **`getEntries` is async.** Was sync stub returning `[]`; now must be async because `Storage.read` is async. Extensions need to `await ctx.getEntries(...)`.
- **`appendEntry` returns `Promise<string>`** (entry ID). Was sync no-op. Extensions can use the returned ID to reference the entry later.
- **`custom_message` entries injected inline chronologically** following pi's pattern. They become user-role messages in the LLM context at their timestamp position, not a separate section.
- **`custom` entries never appear in LLM context.** They're purely for extension state persistence.
- **Both entry types survive compaction.** `custom` entries aren't in the message stream; `custom_message` entries are loaded fresh from Storage each time context is built.
- **`display` field on `CustomMessageEntry`** is for future TUI rendering support, currently unused but stored for when the TUI is wired.
- **No `firstKeptEntryId` concept.** Redsun uses `filterCompacted()` on the message stream. Custom message entries are injected after compacting, so they're always present.