import type { ModelInfo } from "@opencode/client"
import { createMemo, createSignal, Show } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogIntegration } from "./dialog-integration"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"
import { modelPreferenceKey } from "../model-preference"
import { useLocation } from "../context/location"
import { groupByProvider, providerRowTitle } from "../util/provider-menu"
import { useLanguage } from "../i18n"
import { useNewDesigns } from "../config"
import { DialogFreeModels } from "./dialog-model-free"
import { FavoriteMarker, ModelDetail, isFreeModel, prioritizeFavorites, sortModelOptions } from "./model-options"

export function DialogModel(props: {
  providerID?: string
  title?: string
  current?: { providerID: string; modelID: string }
  closeOnSelect?: boolean
  onSelect?: (model: { providerID: string; modelID: string }) => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  const newDesigns = useNewDesigns()
  const connected = useConnected()

  function select(providerID: string, modelID: string) {
    // REDSUN: callers such as the worker-model picker take the selection themselves.
    if (props.onSelect) {
      props.onSelect({ providerID, modelID })
      if (props.closeOnSelect !== false) dialog.clear()
      return
    }
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  function connect() {
    dialog.replace(() => (
      <DialogIntegration onConnected={(providerID) => dialog.replace(() => <DialogModel providerID={providerID} />)} />
    ))
  }

  return (
    <Show
      when={newDesigns() && !connected() && !props.providerID}
      fallback={
        <DialogConnectedModels
          providerID={props.providerID}
          title={props.title}
          current={props.current}
          onSelect={select}
          onConnect={connect}
        />
      }
    >
      <DialogFreeModels onSelect={select} onConnect={connect} />
    </Show>
  )
}

function DialogConnectedModels(props: {
  providerID?: string
  title?: string
  current?: { providerID: string; modelID: string }
  onSelect: (providerID: string, modelID: string) => void
  onConnect: () => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  const newDesigns = useNewDesigns()
  const data = useData()
  const location = useLocation()
  const { t } = useLanguage()
  dialog.setPlacement("bottom")
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal(new Set<string>())
  // Under new designs, favoriting does not reorder the list until the dialog is reopened.
  const favoritesAtOpen = [...local.model.favorite()]
  const favoritePriority = new Set(favoritesAtOpen.map(modelPreferenceKey))
  const isFavorite = (value: { providerID: string; modelID?: string } | undefined) =>
    value?.modelID !== undefined &&
    local.model.favorite().some((item) => item.providerID === value.providerID && item.modelID === value.modelID)
  // Under new designs the detail row shows the price, so the trailing slot only marks favorites.
  const trailing = (model: ModelInfo, favorite: boolean) => {
    if (newDesigns()) return favorite ? <FavoriteMarker /> : undefined
    return isFreeModel(model) ? t("model.tag.free") : undefined
  }
  // OpenCode's own free models get their own group at the end of the list instead of joining "OpenCode".
  const freeGroup = (model: ModelInfo) =>
    newDesigns() && !props.providerID && model.providerID === "opencode" && isFreeModel(model)

  function toggleProvider(providerID: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(providerID)) next.delete(providerID)
      else next.add(providerID)
      return next
    })
  }

  const connected = useConnected()
  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? (newDesigns() ? favoritesAtOpen : local.model.favorite()) : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const model = models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        const provider = providers().get(model.providerID)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: provider?.name ?? model.providerID,
            category,
            footer: trailing(model, isFavorite(item)),
            detail: newDesigns() ? () => <ModelDetail model={model} /> : undefined,
            onSelect: () => {
              props.onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, t("ui.favorites"))
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      t("ui.recent"),
    )

    const modelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          const value = { providerID: model.providerID, modelID: model.id }
          // Users with nothing connected can only favorite models in the free picker (new designs); this picker keeps them unavailable.
          const favorite = connected() && isFavorite(value)
          return {
            value,
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            title: model.name,
            releaseDate: model.time.released,
            description: newDesigns() ? undefined : favorite ? `(${t("ui.favorite")})` : undefined,
            category: connected()
              ? freeGroup(model)
                ? t("model.tag.free")
                : (provider?.name ?? model.providerID)
              : undefined,
            footer: trailing(model, favorite),
            free: isFreeModel(model),
            detail: newDesigns() ? () => <ModelDetail model={model} /> : undefined,
            onSelect() {
              props.onSelect(model.providerID, model.id)
            },
          }
        })
        .filter((option) => {
          if (!showSections) return true
          if (
            favorites.some(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          )
            return false
          if (
            recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
          )
            return false
          return true
        }),
      connected(),
    )

    if (needle) {
      const results = prioritizeFavorites(
        sortModelOptions(
          fuzzysort.go(needle, modelOptions, { keys: ["title", "category"] }).map((item) => item.obj),
          false,
        ),
        favoritePriority,
      )
      // Search results name the provider inline. Without a category, the trailing slot keeps the favorite marker
      // instead of falling back to the provider name.
      if (!newDesigns()) return results
      return results.map((option) => ({ ...option, description: option.providerName, category: undefined }))
    }

    if (!showSections) return [...favoriteOptions, ...recentOptions, ...modelOptions]

    // REDSUN: providers fold into expandable sections; the free group (new designs) trails them.
    const freeLabel = t("model.tag.free")
    const freeOptions = modelOptions.filter((option) => option.category === freeLabel)
    const groups = groupByProvider(
      modelOptions.filter((option) => option.category !== freeLabel),
      (option) => option.providerID,
    )

    const providerSections = Array.from(groups, ([providerID, items]) => {
      const open = expanded().has(providerID)
      return [
        {
          value: { providerID },
          title: providerRowTitle(items[0]?.providerName ?? providerID, open),
          description: t("models.count", { count: items.length }),
          category: t("settings.providers.title"),
          onSelect: () => toggleProvider(providerID),
        },
        ...(open
          ? items.map((option) => ({ ...option, category: t("settings.providers.title"), title: `  ${option.title}` }))
          : []),
      ]
    }).flat()

    return [...favoriteOptions, ...recentOptions, ...providerSections, ...freeOptions]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    if (props.title) return props.title
    const value = provider()
    if (!value) return t("dialog.model.select.title")
    return value.name
  })

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: newDesigns()
            ? connected()
              ? "connect integration"
              : "view all integrations"
            : connected()
              ? t("ui.connectAnIntegration")
              : t("ui.viewAllIntegrations"),
          selection: "none",
          onTrigger: props.onConnect,
        },
        {
          command: "model.dialog.favorite",
          title: newDesigns() ? (option) => (isFavorite(option?.value) ? "unfavorite" : "favorite") : t("ui.favorite"),
          hidden: !connected(),
          disabled: (option) => !option || !(option.value as { modelID?: string }).modelID,
          onTrigger: (option) => {
            const value = option.value as { providerID: string; modelID?: string }
            if (!value.modelID) return
            local.model.toggleFavorite({ providerID: value.providerID, modelID: value.modelID })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={props.current ?? local.model.current()}
      focusCurrent={false}
    />
  )
}
