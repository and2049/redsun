import { createMemo, createSignal, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"

export function DialogModel(props: {
  providerID?: string
  title?: string
  current?: { providerID: string; modelID: string }
  onSelect?: (
    model: { providerID: string; modelID: string },
    context: { active: () => boolean },
  ) => Promise<void> | void
  onError?: (error: unknown) => void
  closeOnSelect?: boolean
}) {
  let active = true
  onCleanup(() => {
    active = false
  })
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  dialog.setPlacement("bottom")
  const [query, setQuery] = createSignal("")
  const [expanded, setExpanded] = createSignal(new Set<string>())

  function toggleProvider(providerID: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(providerID)) next.delete(providerID)
      else next.add(providerID)
      return next
    })
  }

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
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

    const providerGroups = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      map((provider) => ({
        provider,
        models: pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      })),
    )
    const providerOptions = providerGroups.flatMap((group) => group.models)

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
          false,
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    // Single-provider and not-connected views keep the flat list.
    if (!showSections) return [...providerOptions, ...popularProviders]

    // Browsing with providers connected: collapse each provider behind a
    // toggle row so long model lists don't drown the menu. Searching above
    // still matches every model regardless of collapse state.
    const providerSections = providerGroups.flatMap(({ provider, models }) => {
      if (models.length === 0) return []
      const open = expanded().has(provider.id)
      return [
        {
          value: { providerID: provider.id },
          title: `${open ? "▾" : "▸"} ${provider.name}`,
          description: models.length === 1 ? "1 model" : `${models.length} models`,
          category: "Providers",
          onSelect: () => toggleProvider(provider.id),
        },
        ...(open
          ? models.map((option) => ({ ...option, category: "Providers", title: `  ${option.title}` }))
          : []),
      ]
    })

    return [...favoriteOptions, ...recentOptions, ...providerSections]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return props.title ?? "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    if (props.onSelect) {
      void Promise.resolve(props.onSelect({ providerID, modelID }, { active: () => active }))
        .then(() => {
          if (active && props.closeOnSelect !== false) dialog.clear()
        })
        .catch((error) => props.onError?.(error))
      return
    }
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
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
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
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
      title={props.title ?? title()}
      current={props.current ?? local.model.current()}
    />
  )
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
