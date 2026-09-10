import { createMemo, createResource, createSignal, Show } from "solid-js"
import type { Config } from "@opencode/schema/config"
import { useConfig } from "../config"
import { useTheme, useThemes } from "../context/theme"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { languages, useLanguage } from "../i18n"
import { useDialog } from "../ui/dialog"
import { DialogLanguage } from "./dialog-language"

type Setting = {
  title: string
  category: string
  path: string[]
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
  keywords?: readonly string[]
  backend?: boolean
  description?: string
  warning?: string
}

export const settings: Setting[] = [
  {
    title: "Interface language",
    category: "Appearance",
    path: ["language"],
    default: "en",
    keywords: ["language", "locale", "translation", "中文", "Español", "한국어", "Français"],
  },
  {
    title: "Stale-read deduplication",
    category: "Context",
    path: ["stale_read_deduplication"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    backend: true,
    warning: "Warning: may break prompt caching and increase costs.",
    keywords: ["cache", "context optimizer", "pruning", "reads"],
  },
  {
    title: "Compaction mode",
    category: "Context",
    path: ["compaction", "strategy"],
    default: "llm",
    values: ["llm", "hybrid", "algorithmic"],
    labels: ["LLM", "Hybrid", "Algorithmic"],
    backend: true,
    description: "LLM: model summary. Hybrid: adds an inventory. Algorithmic: inventory only, no model call.",
    keywords: ["summary", "compression", "context", "hybrid", "algorithmic"],
  },
  {
    title: "Theme",
    category: "Appearance",
    path: ["theme", "name"],
    default: "opencode",
    keywords: ["color scheme", "colors"],
  },
  {
    title: "Animations",
    category: "Appearance",
    path: ["animations"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["motion", "effects"],
  },
  {
    title: "Sidebar",
    category: "Session",
    path: ["session", "sidebar"],
    default: "auto",
    values: ["hide", "auto"],
    keywords: ["side panel"],
  },
  {
    title: "Scrollbar",
    category: "Session",
    path: ["session", "scrollbar"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll bar"],
  },
  {
    title: "Thinking",
    category: "Session",
    path: ["session", "thinking"],
    default: "hide",
    values: ["hide", "show"],
    keywords: ["reasoning", "chain of thought"],
  },
  {
    title: "Markdown",
    category: "Session",
    path: ["session", "markdown"],
    default: "rendered",
    values: ["source", "rendered"],
    keywords: ["syntax", "concealment", "rendering"],
  },
  {
    title: "Tool grouping",
    category: "Session",
    path: ["session", "grouping"],
    default: "auto",
    values: ["none", "auto"],
    keywords: ["transcript", "messages", "reads", "searches"],
  },
  {
    title: "Transcript images",
    category: "Session",
    path: ["session", "image_preview"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "images", "tool output"],
  },
  {
    title: "TPS",
    category: "Session",
    path: ["session", "tps"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["tokens per second", "throughput"],
  },
  {
    title: "New session location",
    category: "Session",
    path: ["session", "new_location"],
    default: "launch",
    values: ["launch", "inherit"],
    labels: ["launch directory", "active session"],
    keywords: ["directory", "cwd", "inherit"],
  },
  {
    title: "Session list scope",
    category: "Session",
    path: ["tabs", "scope"],
    default: "cwd",
    values: ["cwd", "global"],
    labels: ["current directory", "global"],
    keywords: ["sessions", "projects", "directory"],
  },
  {
    title: "Layout",
    category: "Diffs",
    path: ["diffs", "view"],
    default: "auto",
    values: ["auto", "split", "unified"],
    keywords: ["diff layout", "split diff", "unified diff"],
  },
  {
    title: "Wrapping",
    category: "Diffs",
    path: ["diffs", "wrap"],
    default: "word",
    values: ["none", "word"],
    keywords: ["diff wrap", "word wrap", "line wrap"],
  },
  {
    title: "File tree",
    category: "Diffs",
    path: ["diffs", "tree"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["diff files"],
  },
  {
    title: "Single patch",
    category: "Diffs",
    path: ["diffs", "single"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["one file", "selected file"],
  },
  {
    title: "Scroll speed",
    category: "Input",
    path: ["scroll", "speed"],
    default: 3,
    step: 0.25,
    min: 0.25,
    max: 10,
    format: (value) => Number(value).toFixed(2),
    keywords: ["scrolling"],
  },
  {
    title: "Acceleration",
    category: "Input",
    path: ["scroll", "acceleration"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll acceleration"],
  },
  {
    title: "Mouse",
    category: "Input",
    path: ["mouse"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["mouse capture"],
  },
  {
    title: "Editor context",
    category: "Input",
    path: ["prompt", "editor"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["file context", "prompt context", "editor selection"],
  },
  {
    title: "Large pastes",
    category: "Input",
    path: ["prompt", "paste"],
    default: "compact",
    values: ["compact", "full"],
    keywords: ["paste summary", "clipboard", "pasted content"],
  },
  {
    title: "Image previews",
    category: "Input",
    path: ["prompt", "image_preview"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "clipboard", "images", "prompt"],
  },
  {
    title: "Leader timeout",
    category: "Input",
    path: ["leader", "timeout"],
    default: 2000,
    step: 250,
    min: 250,
    max: 10000,
    format: (value) => `${value} ms`,
    keywords: ["leader key", "shortcut timeout"],
  },
  {
    title: "Attention",
    category: "Alerts",
    path: ["attention", "enabled"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["alerts"],
  },
  {
    title: "Notifications",
    category: "Alerts",
    path: ["attention", "notifications"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["system notifications", "desktop notifications", "alerts"],
  },
  {
    title: "Sounds",
    category: "Alerts",
    path: ["attention", "sound"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["audio", "sound effects"],
  },
  {
    title: "Volume",
    category: "Alerts",
    path: ["attention", "volume"],
    default: 0.4,
    step: 0.1,
    min: 0,
    max: 1,
    format: (value) => `${Math.round(Number(value) * 100)}%`,
    keywords: ["sound volume", "audio volume"],
  },
  {
    title: "Window title",
    category: "Terminal",
    path: ["terminal", "title"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["terminal title", "tab title"],
  },
  {
    title: "Copy behavior",
    category: "Terminal",
    path: ["terminal", "copy"],
    default: process.platform === "win32" ? "manual" : "select",
    values: ["manual", "select"],
    keywords: ["selection", "clipboard"],
  },
  {
    title: "Developer tools",
    category: "Debug",
    path: ["debug", "devtools"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["debug bar", "developer tools"],
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

export function DialogConfig(props: { current?: string }) {
  const { t } = useLanguage()
  const dialog = useDialog()
  const config = useConfig()
  const toast = useToast()
  const themes = useThemes()
  const theme = useTheme()
  const client = useClient()
  const location = useLocation()
  const data = useData()
  const ref = () => {
    const target = location.ref ?? data.location.default()
    return { directory: target.directory, workspace: target.workspaceID }
  }
  const current = Math.max(
    0,
    settings.findIndex((setting) => settingID(setting) === props.current),
  )
  const [selected, setSelected] = createSignal(current)
  const [saving, setSaving] = createSignal(false)
  const [backend, { mutate, refetch }] = createResource(async () => {
    try {
      return await client.api.config.context.get({ location: ref() })
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error) })
      return undefined
    }
  })

  const value = (setting: Setting) => {
    const current = setting.path.reduce<unknown>(
      (result, key) => {
        if (!result || typeof result !== "object") return undefined
        return (result as Record<string, unknown>)[key]
      },
      setting.backend ? backend() : config.data,
    )
    if (setting.path.join(".") === "theme.name") return current ?? themes.selected
    return current ?? setting.default
  }
  const values = (setting: Setting) =>
    setting.path.join(".") === "theme.name"
      ? Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      : setting.values
  const display = (setting: Setting) => {
    const current = value(setting)
    if (settingID(setting) === "language")
      return languages.find((language) => language.value === current)?.name ?? "English"
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    if (settingID(setting) === "theme.name") return String(current)
    return t(index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current)))
  }
  const options = createMemo(() =>
    settings.map((setting, index) => ({
      title: t(setting.title),
      category: t(setting.category),
      searchText: [setting.title, setting.category, ...(setting.keywords ?? [])].join(" "),
      footer: setting.backend && !backend() ? t(backend.loading ? "loading" : "unavailable") : display(setting),
      value: index,
    })),
  )

  async function change(direction: number, index = selected()) {
    if (saving()) return
    const setting = settings[index]
    if (settingID(setting) === "language") {
      const back = () => dialog.replace(() => <DialogConfig current="language" />)
      dialog.replace(() => <DialogLanguage onSelect={back} onCancel={back} />)
      return
    }
    if (setting.backend && !backend()) {
      void refetch()
      return
    }
    const current = value(setting)
    const choices = values(setting)
    const next = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    if (next === current) return
    setSaving(true)
    if (setting.backend) {
      const update: Config.ContextSettings =
        setting.path[0] === "stale_read_deduplication"
          ? { stale_read_deduplication: next === true }
          : { compaction: { strategy: next === "hybrid" || next === "algorithmic" ? next : "llm" } }
      await client.api.config.context
        .update({ location: ref(), payload: update })
        .then(mutate)
        .catch((error) => toast.show({ variant: "error", message: errorMessage(error) }))
        .finally(() => setSaving(false))
      return
    }
    await config
      .update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        parent[setting.path.at(-1)!] = next
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  return (
    <DialogSelect
      title={t("Settings")}
      options={options()}
      current={current}
      filterThreshold={0.7}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => void change(1, option.value)}
      footerHints={[{ title: "←/→", label: t("change") }]}
      footer={
        <Show when={settings[selected()]?.backend}>
          <box paddingLeft={4} paddingRight={4} flexDirection="column">
            <text fg={theme.text.subdued}>{t("Global defaults; other config sources can override.")}</text>
            <text fg={settings[selected()]?.warning ? theme.text.feedback.warning.default : theme.text.subdued}>
              {t(settings[selected()]?.warning ?? settings[selected()]?.description ?? "")}
            </text>
          </box>
        </Show>
      }
      bindings={[
        {
          bind: "left",
          title: "Previous value",
          group: "Settings",
          run: () => void change(-1),
        },
        {
          bind: "right",
          title: "Next value",
          group: "Settings",
          run: () => void change(1),
        },
      ]}
    />
  )
}
