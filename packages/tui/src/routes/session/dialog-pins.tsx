import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { SessionMessageInfo } from "@opencode/client"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useData } from "../../context/data"
import { useClient } from "../../context/client"
import { useTheme, useThemes } from "../../context/theme"
import { useClipboard } from "../../context/clipboard"
import { Keymap } from "../../context/keymap"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useToast } from "../../ui/toast"
import { useLanguage } from "../../i18n"
import { Locale } from "../../util/locale"
import { messageText, pinToolText } from "./pin-text"
import { SessionMessagePin } from "@opencode/schema/session-message-pin"

export function DialogPins(props: { sessionID: string; onJump: (messageID: string) => void }) {
  const data = useData()
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()
  const theme = useTheme("elevated")
  const { t } = useLanguage()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [selected, setSelected] = createSignal<string>()
  const [view, setView] = createSignal<"list" | "reader" | "rename">("list")
  const [message, setMessage] = createSignal<SessionMessageInfo>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  let query = ""
  let alive = true
  let request: AbortController | undefined
  onCleanup(() => {
    alive = false
    request?.abort()
  })
  const pins = () => data.session.pins.list(props.sessionID)
  const pin = createMemo(() => pins().find((item) => item.messageID === selected()))
  const title = () => (pin()?.label ?? (pin()?.preview || t("pins.message"))).replace(/\s+/g, " ")
  const back = () => {
    request?.abort()
    setView("list")
    setLoading(false)
  }
  onMount(() => {
    dialog.setSize("xlarge")
    dialog.setCentered(true)
  })
  void data.session.pins
    .sync(props.sessionID, { force: true })
    .then(() => {
      if (alive) setLoading(false)
    })
    .catch((error) => {
      if (!alive) return
      setLoading(false)
      setFailed(true)
      toast.error(error)
    })
  const open = (id: string) => {
    request?.abort()
    const current = new AbortController()
    request = current
    setSelected(id)
    setMessage(undefined)
    setFailed(false)
    setLoading(true)
    setView("reader")
    void client.api.session
      .message({ sessionID: props.sessionID, messageID: id }, { signal: current.signal })
      .then((response) => {
        if (!alive || current.signal.aborted) return
        setMessage(response)
        setLoading(false)
      })
      .catch((error) => {
        if (!alive || current.signal.aborted) return
        setFailed(true)
        setLoading(false)
        toast.error(error)
      })
  }
  const mutate = (operation: () => Promise<void>, next: () => void) => {
    if (busy()) return
    setBusy(true)
    void operation()
      .then(() => {
        if (alive) next()
      })
      .catch((error) => {
        if (alive) toast.error(error)
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
  }
  const remove = (id: string) => mutate(() => data.session.pins.remove(props.sessionID, id), back)
  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 2,
    enabled: view() === "reader",
    commands: [
      {
        bind: "escape",
        title: t("application.back"),
        run: () => {
          if (renderer.getSelection()) renderer.clearSelection()
          else back()
        },
      },
      {
        bind: "r",
        title: t("pins.rename"),
        run: () => {
          if (pin()) setView("rename")
        },
      },
      {
        bind: "d",
        title: t("pins.unpin"),
        run: () => {
          if (selected()) remove(selected()!)
        },
      },
      {
        bind: "c",
        title: t("session.copy"),
        run: () => {
          const value = message()
          if (value) void clipboard.write(messageText(value)).catch((error) => toast.error(error))
        },
      },
      {
        bind: "return",
        title: t("session.jumpTo"),
        run: () => {
          if (message() && pin()) {
            dialog.clear()
            props.onJump(message()!.id)
          }
        },
      },
    ],
  }))
  return (
    <box>
      <Show
        when={view() !== "rename"}
        fallback={
          <DialogPrompt
            size="xlarge"
            title={t("pins.rename")}
            value={pin()?.label ?? ""}
            placeholder={t("pins.labelHint")}
            busy={busy()}
            onCancel={back}
            onConfirm={(label) => {
              if (Array.from(label.trim()).length > SessionMessagePin.LabelLimit) {
                toast.show({ message: t("pins.labelTooLong"), variant: "error" })
                return
              }
              const id = selected()
              if (id) mutate(() => data.session.pins.rename(props.sessionID, id, label.trim() || null), back)
            }}
          />
        }
      >
        <Show
          when={view() === "list"}
          fallback={
            <box paddingLeft={2} paddingRight={2} gap={1}>
              <text fg={theme.text.default}>{Locale.truncate(title(), Math.max(10, dimensions().width - 8))}</text>
              <Show
                when={message()}
                fallback={<text fg={theme.text.subdued}>{loading() ? t("pins.loading") : t("pins.unavailable")}</text>}
              >
                {(value) => <PinReader message={value()} />}
              </Show>
              <box flexDirection="row" flexWrap="wrap" gap={2} paddingBottom={1}>
                <text onMouseUp={back}>{t("pins.backHint")}</text>
                <Show when={pin()}>
                  <text onMouseUp={() => setView("rename")}>{t("pins.renameHint")}</text>
                </Show>
                <text
                  onMouseUp={() => {
                    if (selected()) remove(selected()!)
                  }}
                >
                  {t("pins.unpinHint")}
                </text>
                <Show when={message() && pin()}>
                  <text
                    onMouseUp={() => {
                      dialog.clear()
                      props.onJump(message()!.id)
                    }}
                  >
                    {t("pins.jumpHint")}
                  </text>
                </Show>
                <Show when={message()}>
                  <text
                    onMouseUp={() => {
                      void clipboard.write(messageText(message()!)).catch((error) => toast.error(error))
                    }}
                  >
                    {t("pins.copyHint")}
                  </text>
                </Show>
              </box>
            </box>
          }
        >
          <DialogSelect<string>
            title={t("pins.title")}
            preserveSelection
            current={selected()}
            locked={busy()}
            ref={(ref) => ref.setFilter(query)}
            onFilter={(value) => {
              query = value
            }}
            onMove={(option) => setSelected(option.value)}
            emptyView={
              <text fg={theme.text.subdued}>
                {loading() ? t("pins.loading") : failed() ? t("pins.unavailable") : t("pins.empty")}
              </text>
            }
            options={pins().map((item) => ({
              value: item.messageID,
              title: (item.label ?? (item.preview || t(item.role === "user" ? "pins.user" : "pins.assistant"))).replace(
                /\s+/g,
                " ",
              ),
              description: t(item.role === "user" ? "pins.user" : "pins.assistant"),
              footer: Locale.time(item.messageCreated),
              searchText: `${item.label ?? ""} ${item.preview}`,
              onSelect: () => open(item.messageID),
            }))}
            actions={[
              {
                command: "pins.rename",
                title: t("pins.rename"),
                onTrigger: (option) => {
                  setSelected(option.value)
                  setView("rename")
                },
              },
              { command: "pins.remove", title: t("pins.unpin"), onTrigger: (option) => remove(option.value) },
            ]}
          />
        </Show>
      </Show>
    </box>
  )
}

function PinReader(props: { message: SessionMessageInfo }) {
  const dimensions = useTerminalDimensions()
  const theme = useTheme("elevated")
  const { currentSyntax } = useThemes()
  const { t } = useLanguage()
  let scroll: ScrollBoxRenderable | undefined
  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 1,
    commands: [
      { bind: "up,k", title: t("session.lineUp"), run: () => scroll?.scrollBy(-1) },
      { bind: "down,j", title: t("session.lineDown"), run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: t("session.lineUp"), run: () => scroll?.scrollBy(-(scroll.height - 1)) },
      { bind: "pagedown", title: t("session.lineDown"), run: () => scroll?.scrollBy(scroll.height - 1) },
      { bind: "home", title: t("session.firstMessage"), run: () => scroll?.scrollTo(0) },
      { bind: "end", title: t("session.lastMessage"), run: () => scroll?.scrollTo(scroll.scrollHeight) },
    ],
  }))
  const parts = () => (props.message.type === "assistant" ? props.message.content : [])
  return (
    <scrollbox
      ref={(value) => {
        scroll = value
      }}
      height={Math.max(3, Math.floor(dimensions().height * 0.55))}
    >
      <box gap={1}>
        <Show when={props.message.type === "user"}>
          <markdown content={messageText(props.message)} syntaxStyle={currentSyntax()} fg={theme.markdown.text} />
          <For each={props.message.type === "user" ? props.message.files : []}>
            {(file) => (
              <box>
                <text>{file.name ?? file.mime}</text>
                <Show when={file.mime.startsWith("image/")}>
                  <image
                    source={`data:${file.mime};base64,${file.data}`}
                    fit="fit"
                    protocol="auto"
                    width="100%"
                    height={10}
                  />
                </Show>
              </box>
            )}
          </For>
        </Show>
        <For each={parts()}>
          {(part) => (
            <Show
              when={part.type === "text" || part.type === "reasoning"}
              fallback={<text wrapMode="word">{part.type === "tool" ? pinToolText(part) : ""}</text>}
            >
              <markdown
                content={part.type === "text" || part.type === "reasoning" ? part.text : ""}
                syntaxStyle={currentSyntax()}
                fg={theme.markdown.text}
              />
            </Show>
          )}
        </For>
      </box>
    </scrollbox>
  )
}
