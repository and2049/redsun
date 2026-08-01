// Session-scoped commands and keybindings for the dense shell.
//
// Classic registers these inside routes/session/index.tsx, which the dense
// shell never mounts — without this module `/share`, `/rename`, `/timeline`,
// `/fork`, `/compact`, `/undo`, `/redo`, `/copy`, `/export` and subagent
// navigation simply do not exist in dense mode. Command values, slash names
// and aliases match classic exactly, so keybind config and the palette behave
// the same in both UIs.
//
// Deliberately not ported: the scroll commands (page/line/first/last/message
// navigation) and the render toggles (sidebar, timestamps, conceal, tool
// details, scrollbar, generic tool output). Native scrollback replaces the
// former, and the latter configure a scrollbox that dense does not draw. They
// stay registered in classic, so a `--classic` session is unaffected.
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useRenderer } from "@opentui/solid"
import { createMemo } from "solid-js"
import { DialogSessionRename } from "../component/dialog-session-rename"
import type { PromptInfo } from "../component/prompt/history"
import { useClipboard } from "../context/clipboard"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { useProject } from "../context/project"
import { usePromptRef } from "../context/prompt"
import { useRoute, useRouteData } from "../context/route"
import { useTuiPaths } from "../context/runtime"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { openEditor } from "../editor"
import { OPENCODE_BASE_MODE, useBindings } from "../keymap"
import { DialogForkFromTimeline } from "../routes/session/dialog-fork-from-timeline"
import { DialogTimeline } from "../routes/session/dialog-timeline"
import { useTuiConfig } from "../config"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogExportOptions } from "../ui/dialog-export-options"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { formatTranscript } from "../util/transcript"

// The subset of classic's `sessionBindingCommands` that dense implements.
const denseBindingCommands = [
  "session.share",
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.unshare",
  "session.undo",
  "session.redo",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

export function useDenseSessionCommands() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const kv = useKV()
  const local = useLocal()
  const project = useProject()
  const paths = useTuiPaths()
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()
  const promptRef = usePromptRef()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()

  const session = createMemo(() => sync.session.get(route.sessionID))
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const foregroundTasks = createMemo(() =>
    sync.data.capabilities.experimentalBackgroundSubagents
      ? messages().flatMap((message) =>
          (sync.data.part[message.id] ?? []).filter(
            (part): part is ToolPart =>
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              part.state.metadata?.background !== true,
          ),
        )
      : [],
  )

  // Shared presentation preferences: dense reads the same keys classic writes,
  // so transcript exports look the same whichever UI produced them.
  const [showDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const showThinking = () => true

  const prompt = () => promptRef.current

  function enterChild(sessionID: string) {
    navigate({ type: "session", sessionID })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return
    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction
    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  async function writeExport(file: string, content: string) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  function transcript(options: { thinking: boolean; toolDetails: boolean; assistantMetadata: boolean }) {
    const data = session()
    if (!data) return
    return formatTranscript(
      data,
      messages().map((message) => ({ info: message, parts: sync.data.part[message.id] ?? [] })),
      { ...options, providers: sync.data.provider },
    )
  }

  const commandList = createMemo(() => [
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: true,
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: { name: "share" },
      run: async () => {
        const copy = (url: string) =>
          clipboard
            .write?.(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({ sessionID: route.sessionID })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      slash: { name: "rename" },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      slash: { name: "timeline" },
      run: () => {
        // Nothing to scroll to in dense — the transcript lives in native
        // scrollback — but the timeline still opens a message for copy/edit.
        dialog.replace(() => (
          <DialogTimeline
            onMove={() => {}}
            sessionID={route.sessionID}
            setPrompt={(info) => prompt()?.set(info)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      slash: { name: "fork" },
      run: () => {
        dialog.replace(() => <DialogForkFromTimeline onMove={() => {}} sessionID={route.sessionID} />)
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      slash: { name: "compact", aliases: ["summarize"] },
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: { name: "unshare" },
      run: async () => {
        await sdk.client.session
          .unshare({ sessionID: route.sessionID })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      slash: { name: "undo" },
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const reverted = session()?.revert?.messageID
        const message = messages().findLast((x) => (!reverted || x.id < reverted) && x.role === "user")
        if (!message) return
        void sdk.client.session.revert({ sessionID: route.sessionID, messageID: message.id })
        const parts = sync.data.part[message.id] ?? []
        prompt()?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text" && !part.synthetic) agg.input += part.text
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: { name: "redo" },
      run: () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({ sessionID: route.sessionID })
          prompt()?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({ sessionID: route.sessionID, messageID: message.id })
      },
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const revertID = session()?.revert?.messageID
        const last = messages().findLast((msg) => msg.role === "assistant" && (!revertID || msg.id < revertID))
        const text = (sync.data.part[last?.id ?? ""] ?? [])
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim()
        if (!text) {
          toast.show({ message: "No assistant message to copy", variant: "error" })
          dialog.clear()
          return
        }
        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: { name: "copy" },
      run: async () => {
        try {
          const text = transcript({
            thinking: showThinking(),
            toolDetails: showDetails(),
            assistantMetadata: showAssistantMetadata(),
          })
          if (!text) return
          await clipboard.write?.(text)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: { name: "export" },
      run: async () => {
        try {
          const data = session()
          if (!data) return
          const options = await DialogExportOptions.show(
            dialog,
            `session-${data.id.slice(0, 8)}.md`,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )
          if (options === null) return

          const text = transcript(options)
          if (!text) return
          const worktree = project.instance.path().worktree
          const cwd = (worktree === "/" ? undefined : worktree) || project.instance.directory() || paths.cwd

          if (options.openWithoutSaving) {
            await openEditor({ renderer, value: text, cwd })
          } else {
            const filename = options.filename.trim()
            const filepath = path.join(paths.cwd, filename)
            await writeExport(filepath, text)
            const result = await openEditor({ renderer, value: text, cwd })
            if (result !== undefined) await writeExport(filepath, result)
            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Background subagents",
      value: "session.background",
      category: "Session",
      hidden: true,
      enabled: foregroundTasks().length > 0,
      run: () => {
        void sdk.client.experimental.session.background({
          sessionID: route.sessionID,
          workspace: project.workspace.current(),
        })
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        moveFirstChild()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) navigate({ type: "session", sessionID: parentID })
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  useBindings(() => ({
    commands: commandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", denseBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))
}
