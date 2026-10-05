import { CliRenderEvents, RGBA, SyntaxStyle, type OptimizedBuffer } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { generateSyntax, resolveThemeDocument, type ResolvedTheme, type SurfaceName } from "@opencode/theme/tui"
import {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  hasTheme,
  parseTheme,
  removeTheme,
  selectedForeground,
  setCustomThemes,
  subscribeThemes,
  themeMode,
  upsertTheme,
  type Theme,
  type ThemeDocumentSource,
} from "../theme"
import { discoverThemes } from "../theme/discovery"
import { SYSTEM_THEME, systemTheme } from "../theme/system"
import { createComponentTheme, type ComponentTheme } from "../theme/component"
import { createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useConfig } from "../config"
import { DevTools } from "../devtools"
import { configDirectories } from "../util/config-directories"
import { createTerminalBackground, keepBackgroundAsForeground } from "../util/terminal-background"

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
  active: string
  ready: boolean
  locked: number
  terminalBackground: boolean
}

type Themes = {
  current: ComponentTheme
  currentTokens: Accessor<ResolvedTheme>
  readonly selected: string
  all: typeof allThemes
  has: typeof hasTheme
  currentSyntax: Accessor<SyntaxStyle>
  mode: Accessor<"dark" | "light">
  terminalBackground: Accessor<boolean>
  setTerminalBackground(enabled: boolean): void
  /** A surface's fill, or the terminal's own background while that is shown, leaving the surface open. */
  open(color: RGBA): RGBA
  set(theme: string): boolean
  select(theme: string): boolean
  register(name: string, document: unknown): (() => void) | undefined
  lock(): () => void
  locked: Accessor<boolean>
  onError(handler: ThemeErrorHandler): () => void
  readonly ready: boolean
}

type ThemeContextValue = {
  current: ComponentTheme
  themes: Themes
  readonly ready: boolean
}

const FALLBACK_THEME = "dusk"

const [store, setStore] = createStore<State>({
  active: FALLBACK_THEME,
  ready: false,
  locked: 0,
  terminalBackground: false,
})
const [themeSources, setThemeSources] = createSignal(allThemes())

subscribeThemes(setThemeSources)

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
        draft.locked = 0
        draft.terminalBackground = config.theme?.terminal_background === true
      }),
    )

    createEffect(() => {
      const theme = config.theme?.name
      if (theme && !store.locked) setStore("active", theme)
    })
    createEffect(() => setStore("terminalBackground", config.theme?.terminal_background === true))

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
        tokens()
        setStore("ready", true)
      })
    })

    let themeRefreshTimeout: ReturnType<typeof setTimeout> | undefined
    const refreshThemes = () => {
      clearTimeout(themeRefreshTimeout)
      themeRefreshTimeout = setTimeout(() => void syncCustomThemes(), THEME_REFRESH_DELAY)
    }
    const unsubscribeRefresh = themes.subscribeRefresh?.(refreshThemes)

    onCleanup(() => {
      unsubscribeRefresh?.()
      clearTimeout(themeRefreshTimeout)
    })

    const initStarted = performance.now()
    const selected = createMemo(() => {
      const sources = themeSources()
      const name = sources[store.active] ? store.active : FALLBACK_THEME
      try {
        return { name, ...loadTheme(sources[name], name) }
      } catch (error) {
        if (name === FALLBACK_THEME) throw error
        themeErrors.emit(name, error)
        setStore("active", FALLBACK_THEME)
        return { name: FALLBACK_THEME, ...loadTheme(sources[FALLBACK_THEME], FALLBACK_THEME) }
      }
    })
    const mode = () => selected().mode
    // The system theme is the terminal's colours, so it always keeps the terminal's background too.
    const terminalBackground = () => store.terminalBackground || selected().name === SYSTEM_THEME
    const tokens = createMemo(() =>
      terminalBackground() ? withTerminalBackground(selected().theme) : selected().theme,
    )
    tokens()
    themePerformance.set("Init", `${(performance.now() - initStarted).toFixed(2)} ms`)
    const current = createComponentTheme(tokens)

    createEffect(() => renderer.setBackgroundColor(tokens().background.base))

    createEffect(() => {
      if (!terminalBackground()) return
      const base = tokens().background.base
      const repaint = (buffer: OptimizedBuffer) => keepBackgroundAsForeground(buffer, base)
      renderer.addPostProcessFn(repaint)
      onCleanup(() => renderer.removePostProcessFn(repaint))
    })

    if (process.stdout.isTTY && !process.env.OPENCODE_DRIVE) {
      const background = createTerminalBackground(renderer, (sequence) => {
        process.stdout.write(sequence)
      })
      renderer.on("destroy", background.dispose)
      onCleanup(() => {
        renderer.off("destroy", background.dispose)
        background.dispose()
      })
      createEffect(() => {
        background.update(tokens().background.base)
      })

      // The system theme exists only once the terminal reports its colours. A user's own
      // theme of that name wins.
      let system: ReturnType<typeof systemTheme>
      const syncSystemTheme = () =>
        void renderer
          .getPalette({ size: 16 })
          .then((colors) => {
            const theme = systemTheme(colors)
            if (!theme || (hasTheme(SYSTEM_THEME) && allThemes()[SYSTEM_THEME] !== system)) return
            system = theme
            upsertTheme(SYSTEM_THEME, theme)
          })
          .catch(() => {})
      // Follow the terminal when it switches palettes. Only while the system theme is
      // shown: under any other theme the reported background is the one written above.
      const refreshSystemTheme = () => {
        if (selected().name !== SYSTEM_THEME) return
        renderer.clearPaletteCache()
        syncSystemTheme()
      }
      syncSystemTheme()
      renderer.on(CliRenderEvents.THEME_MODE, refreshSystemTheme)
      onCleanup(() => renderer.off(CliRenderEvents.THEME_MODE, refreshSystemTheme))
    }

    const currentSyntax = createSyntaxStyleMemo(() => generateSyntax(tokens()))
    const service: Themes = {
      current,
      currentTokens: tokens,
      currentSyntax,
      get selected() {
        return store.active
      },
      all: allThemes,
      has: hasTheme,
      mode,
      terminalBackground,
      open: (color) => (terminalBackground() ? tokens().background.base : color),
      setTerminalBackground(enabled: boolean) {
        setStore("terminalBackground", enabled)
        void configState
          .update((draft) => {
            draft.theme = { ...draft.theme, terminal_background: enabled }
          })
          .catch(() => {})
      },
      set(theme: string) {
        if (store.locked || !hasTheme(theme)) return false
        setStore("active", theme)
        void configState
          .update((draft) => {
            draft.theme = { ...draft.theme, name: theme }
          })
          .catch(() => {})
        return true
      },
      select(theme: string) {
        if (!hasTheme(theme)) return false
        setStore("active", theme)
        return true
      },
      register(name: string, document: unknown) {
        if (!upsertTheme(name, document)) return undefined
        return () => void removeTheme(name)
      },
      lock() {
        setStore("locked", (count) => count + 1)
        let held = true
        return () => {
          if (!held) return
          held = false
          setStore("locked", (count) => Math.max(0, count - 1))
        }
      },
      locked: () => store.locked > 0,
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
export function useTheme(): ComponentTheme {
  return themeContext.use().current
}
export const ThemeProvider = themeContext.provider

/** Switches the ambient theme surface without remounting children; undefined inherits the enclosing view. */
export function ThemeContextProvider(props: ParentProps<{ context: SurfaceName | undefined }>) {
  const value = themeContext.use()
  const current = createComponentTheme(() => {
    const name = props.context
    return name ? value.themes.currentTokens().surface(name) : value.current
  })
  return (
    <themeContext.context.Provider value={{ current, themes: value.themes, ready: value.ready }}>
      {props.children}
    </themeContext.context.Provider>
  )
}

/** Resolves a theme source in the mode it declares; throws on a malformed document. */
export function loadTheme(source: ThemeDocumentSource, name: string) {
  const document = parseTheme(source, name)
  const mode = themeMode(source, name)
  return { mode, theme: resolveThemeDocument(document, mode) }
}

/**
 * The theme with the terminal's own background in place of `background.base`, so window
 * transparency and background images show through. The replacement is opaque to the
 * renderer (popups still cover what is beneath them) and keeps the theme colour as its
 * RGB snapshot, so tints and mixes against the background are unchanged.
 */
export function withTerminalBackground(theme: ResolvedTheme): ResolvedTheme {
  const themed = theme.background.base
  const base = RGBA.defaultBackground(themed)
  // Hue steps are looked up by colour identity.
  const source = (color: RGBA) => (color === base ? themed : color)
  return {
    ...theme,
    background: { ...theme.background, base },
    source: (color) => theme.source(source(color)),
    increase: (color, amount) => theme.increase(source(color), amount),
    decrease: (color, amount) => theme.decrease(source(color), amount),
  }
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
