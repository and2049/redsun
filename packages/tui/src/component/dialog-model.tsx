import { createMemo, createSignal } from "solid-js"
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
import { groupByProvider, providerRowDescription, providerRowTitle } from "../util/provider-menu"

export function DialogModel(props: {
  providerID?: string
  /** REDSUN: the worker picker is this menu pointed at a different sink. */
  title?: string
  current?: { providerID: string; modelID: string }
  closeOnSelect?: boolean
  onSelect?: (model: { providerID: string; modelID: string }) => void
}) {
  const local = useLocal()
  const data = useData()
  const dialog = useDialog()
  const location = useLocation()
  dialog.setPlacement("bottom")
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal(new Set<string>())
  const favoritePriority = new Set(local.model.favorite().map(modelPreferenceKey))

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
    const favorites = connected() ? local.model.favorite() : []
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
            footer: free(model) ? "Free" : undefined,
            onSelect: () => {
              onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const modelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          const key = modelPreferenceKey({ providerID: model.providerID, modelID: model.id })
          const favorite = favorites.some((item) => modelPreferenceKey(item) === key)
          return {
            value: { providerID: model.providerID, modelID: model.id },
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            title: model.name,
            releaseDate: model.time.released,
            description: favorite ? "(Favorite)" : undefined,
            category: connected() ? (provider?.name ?? model.providerID) : undefined,
            footer: free(model) ? "Free" : undefined,
            onSelect() {
              onSelect(model.providerID, model.id)
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
    )

    if (needle) {
      return prioritizeFavorites(
        fuzzysort.go(needle, modelOptions, { keys: ["title", "category"] }).map((item) => item.obj),
        favoritePriority,
      )
    }

    // A single provider's list, or a disconnected one, is short enough to read
    // whole -- there is nothing to collapse it against.
    if (!showSections) return [...favoriteOptions, ...recentOptions, ...modelOptions]

    // REDSUN DENSE: browsing with providers connected, each provider is one row
    // until you open it. Connect four providers and the flat list is hundreds of
    // models deep, which makes the menu something to scroll rather than
    // something to read. Typing still searches across every provider regardless
    // of what is open, so collapsing costs nothing to anyone who knows the name
    // of the model they want.
    const groups = groupByProvider(modelOptions, (option) => option.providerID)

    const providerSections = Array.from(groups, ([providerID, items]) => {
      const open = expanded().has(providerID)
      return [
        {
          value: { providerID },
          title: providerRowTitle(items[0]?.providerName ?? providerID, open),
          description: providerRowDescription(items.length),
          category: "Providers",
          onSelect: () => toggleProvider(providerID),
        },
        ...(open ? items.map((option) => ({ ...option, category: "Providers", title: `  ${option.title}` })) : []),
      ]
    }).flat()

    return [...favoriteOptions, ...recentOptions, ...providerSections]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    if (props.title) return props.title
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
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

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect an integration" : "View all integrations",
          selection: "none",
          onTrigger() {
            dialog.replace(() => (
              <DialogIntegration
                onConnected={(providerID) => dialog.replace(() => <DialogModel providerID={providerID} />)}
              />
            ))
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          // A provider's own row has no model to favourite.
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

export function prioritizeFavorites<T extends { value: { providerID: string; modelID: string } }>(
  options: T[],
  favorites: Set<string>,
) {
  return options.toSorted(
    (a, b) => Number(favorites.has(modelPreferenceKey(b.value))) - Number(favorites.has(modelPreferenceKey(a.value))),
  )
}

export function sortModelOptions<
  T extends { providerID?: string; providerName?: string; releaseDate: string | number; title: string },
>(options: T[]) {
  return options.toSorted((a, b) => {
    const provider = Number(a.providerID !== "opencode") - Number(b.providerID !== "opencode")
    if (provider !== 0) return provider

    const name = (a.providerName ?? "").localeCompare(b.providerName ?? "")
    if (name !== 0) return name

    const release = Number(b.releaseDate) - Number(a.releaseDate)
    if (release !== 0) return release

    return a.title.localeCompare(b.title)
  })
}

function free(model: { cost: Array<{ input: number }> }) {
  return model.cost.length > 0 && model.cost.every((cost) => cost.input === 0)
}
