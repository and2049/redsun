import { SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { generateSyntax, resolveThemeDocument, type ResolvedTheme, type ContextName } from "@opencode-ai/theme/tui"
import {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  hasTheme,
  parseTheme,
  selectedForeground,
  setCustomThemes,
  subscribeThemes,
  themeMode,
  upsertTheme,
  type Theme,
  type ThemeDocumentSource,
} from "../theme"
import { discoverThemes } from "../theme/discovery"
import { createComponentTheme, createComponentThemeView, type ComponentTheme } from "../theme/component"
import { createEffect, createMemo, onCleanup, onMount, type Accessor, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useConfig } from "../config"
import { DevTools } from "../devtools"
import { configDirectories } from "../util/config-directories"

const themePerformance = DevTools.register({ id: "theme-performance", title: "Theme performance" })
export type ThemeError = { name: string; error: Error }
type ThemeErrorHandler = (event: ThemeError) => void

function createThemeErrors() {
  let handler: ThemeErrorHandler | undefined
  let pending: ThemeError | undefined

  return {
    emit(name: string, cause: unknown) {
      const event = { name, error: cause instanceof Error ? cause : new Error(String(cause)) }
      if (handler) {
        handler(event)
        return
      }
      pending = event
    },
    onError(next: ThemeErrorHandler) {
      handler = next
      if (pending) {
        next(pending)
        pending = undefined
      }
      return () => {
        if (handler === next) handler = undefined
      }
    },
  }
}

const themeErrors = createThemeErrors()

export type ThemeSource = Readonly<{
  discover(): Promise<Record<string, unknown>>
  subscribeRefresh?(refresh: () => void): () => void
}>

export const createThemeSource = (config: string): ThemeSource => ({
  async discover() {
    return discoverThemes(configDirectories(config, process.cwd()))
  },
  subscribeRefresh(refresh) {
    process.on("SIGUSR2", refresh)
    return () => process.off("SIGUSR2", refresh)
  },
})

export { discoverThemes } from "../theme/discovery"

export {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSyntax,
  hasTheme,
  selectedForeground,
  themeMode,
  upsertTheme,
  type Theme,
} from "../theme"

const THEME_REFRESH_DELAY = 1000

type State = {
  themes: Record<string, ThemeDocumentSource>
  active: string
  ready: boolean
}

type Themes = {
  current: ComponentTheme
  currentTokens: Accessor<ResolvedTheme>
  readonly selected: string
  all: typeof allThemes
  has: typeof hasTheme
  currentSyntax: Accessor<SyntaxStyle>
  mode: Accessor<"dark" | "light">
  set(theme: string): boolean
  onError(handler: ThemeErrorHandler): () => void
  readonly ready: boolean
}

type ThemeContextValue = {
  current: ComponentTheme["contextual"][ContextName]
  themes: Themes
  readonly ready: boolean
}

const FALLBACK_THEME = "dusk"

const [store, setStore] = createStore<State>({
  themes: allThemes(),
  active: FALLBACK_THEME,
  ready: false,
})

subscribeThemes((themes) => setStore("themes", themes))

const themeContext = createSimpleContext({
  name: "Theme",
  init: (props: { source: ThemeSource }): ThemeContextValue => {
    const renderer = useRenderer()
    const configState = useConfig()
    const config = configState.data
    const themes = props.source

    setStore(
      produce((draft) => {
        const active = config.theme?.name ?? FALLBACK_THEME
        draft.active = typeof active === "string" ? active : FALLBACK_THEME
        draft.ready = false
      }),
    )

    createEffect(() => {
      const theme = config.theme?.name
      if (theme) setStore("active", theme)
    })

    function syncCustomThemes() {
      return themes
        .discover()
        .then((themes) => {
          setCustomThemes(themes)
        })
        .catch(() => setStore("active", FALLBACK_THEME))
    }

    onMount(() => {
      void syncCustomThemes().finally(() => {
        valuesV2()
        setStore("ready", true)
      })
    })

    let themeRefreshTimeout: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(themeRefreshTimeout)
      themeRefreshTimeout = setTimeout(() => void syncCustomThemes(), THEME_REFRESH_DELAY)
    }
    const unsubscribeRefresh = themes.subscribeRefresh?.(refresh)

    onCleanup(() => {
      unsubscribeRefresh?.()
      clearTimeout(themeRefreshTimeout)
    })

    const initStarted = performance.now()
    const selected = createMemo(() => {
      const name = store.themes[store.active] ? store.active : FALLBACK_THEME
      try {
        return loadTheme(store.themes[name], name)
      } catch (error) {
        if (name === FALLBACK_THEME) throw error
        themeErrors.emit(name, error)
        setStore("active", FALLBACK_THEME)
        return loadTheme(store.themes[FALLBACK_THEME], FALLBACK_THEME)
      }
    })
    const mode = () => selected().mode
    const valuesV2 = () => selected().theme
    valuesV2()
    themePerformance.set("Init", `${(performance.now() - initStarted).toFixed(2)} ms`)
    const current = createComponentTheme(valuesV2, mode)

    createEffect(() => renderer.setBackgroundColor(valuesV2().background.default))

    const currentSyntax = createSyntaxStyleMemo(() => generateSyntax(valuesV2(), mode()))
    const service: Themes = {
      current,
      currentTokens: valuesV2,
      currentSyntax,
      get selected() {
        return store.active
      },
      all: allThemes,
      has: hasTheme,
      mode,
      set(theme: string) {
        if (!hasTheme(theme)) return false
        setStore("active", theme)
        void configState
          .update((draft) => {
            draft.theme = { ...draft.theme, name: theme }
          })
          .catch(() => {})
        return true
      },
      onError: themeErrors.onError,
      get ready() {
        return store.ready
      },
    }
    return {
      current,
      themes: service,
      get ready() {
        return service.ready
      },
    }
  },
})

export function useThemes() {
  return themeContext.use().themes
}
export function useTheme(): ComponentTheme
export function useTheme(context: ContextName): ComponentTheme["contextual"][ContextName]
export function useTheme(context?: ContextName) {
  const value = themeContext.use()
  return context ? value.themes.current.contextual[context] : value.current
}
export const ThemeProvider = themeContext.provider

/** Switches context without remounting children; undefined inherits the enclosing view. */
export function ThemeContextProvider(props: ParentProps<{ context: ContextName | undefined }>) {
  const value = themeContext.use()
  const current = createComponentThemeView(() => {
    const name = props.context
    return name ? value.themes.currentTokens().contextual[name] : value.current
  }, value.themes.mode)
  return (
    <themeContext.context.Provider value={{ current, themes: value.themes, ready: value.ready }}>
      {props.children}
    </themeContext.context.Provider>
  )
}

function loadTheme(source: ThemeDocumentSource, name: string) {
  const document = parseTheme(source, name)
  const mode = themeMode(source, name)
  return { mode, theme: resolveThemeDocument(document, mode) }
}

export function createSyntaxStyleMemo(factory: () => SyntaxStyle) {
  const renderer = useRenderer()
  const retained = new Set<SyntaxStyle>()
  let current: SyntaxStyle | undefined

  const release = (style: SyntaxStyle) => {
    retained.add(style)
    void renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!retained.delete(style)) return
        style.destroy()
      })
  }

  onCleanup(() => {
    if (current) release(current)
  })

  return createMemo(() => {
    const previous = current
    current = factory()
    if (previous) release(previous)
    return current
  })
}
