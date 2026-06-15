export namespace Flag {
  export const REDSUN_GIT_BASH_PATH = process.env["REDSUN_GIT_BASH_PATH"]
  export const REDSUN_CONFIG = process.env["REDSUN_CONFIG"]
  export const REDSUN_CONFIG_DIR = process.env["REDSUN_CONFIG_DIR"]
  export const REDSUN_CONFIG_CONTENT = process.env["REDSUN_CONFIG_CONTENT"]
  export const REDSUN_DISABLE_PRUNE = truthy("REDSUN_DISABLE_PRUNE")
  export const REDSUN_DISABLE_TERMINAL_TITLE = truthy("REDSUN_DISABLE_TERMINAL_TITLE")
  export const REDSUN_PERMISSION = process.env["REDSUN_PERMISSION"]
  export const REDSUN_DISABLE_DEFAULT_PLUGINS = truthy("REDSUN_DISABLE_DEFAULT_PLUGINS")
  export const REDSUN_DISABLE_LSP_DOWNLOAD = truthy("REDSUN_DISABLE_LSP_DOWNLOAD")
  export const REDSUN_ENABLE_EXPERIMENTAL_MODELS = truthy("REDSUN_ENABLE_EXPERIMENTAL_MODELS")
  export const REDSUN_DISABLE_AUTOCOMPACT = truthy("REDSUN_DISABLE_AUTOCOMPACT")
  export const REDSUN_DISABLE_MODELS_FETCH = truthy("REDSUN_DISABLE_MODELS_FETCH")
  export const REDSUN_FAKE_VCS = process.env["REDSUN_FAKE_VCS"]
  export const REDSUN_CLIENT = process.env["REDSUN_CLIENT"] ?? "cli"

  // Experimental
  export const REDSUN_EXPERIMENTAL = truthy("REDSUN_EXPERIMENTAL")
  export const REDSUN_EXPERIMENTAL_FILEWATCHER = truthy("REDSUN_EXPERIMENTAL_FILEWATCHER")
  export const REDSUN_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("REDSUN_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const REDSUN_EXPERIMENTAL_ICON_DISCOVERY =
    REDSUN_EXPERIMENTAL || truthy("REDSUN_EXPERIMENTAL_ICON_DISCOVERY")
  export const REDSUN_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = truthy("REDSUN_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const REDSUN_ENABLE_EXA =
    truthy("REDSUN_ENABLE_EXA") || REDSUN_EXPERIMENTAL || truthy("REDSUN_EXPERIMENTAL_EXA")
  export const REDSUN_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH = number("REDSUN_EXPERIMENTAL_BASH_MAX_OUTPUT_LENGTH")
  export const REDSUN_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("REDSUN_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const REDSUN_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("REDSUN_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const REDSUN_EXPERIMENTAL_OXFMT = REDSUN_EXPERIMENTAL || truthy("REDSUN_EXPERIMENTAL_OXFMT")
  export const REDSUN_EXPERIMENTAL_LSP_TY = truthy("REDSUN_EXPERIMENTAL_LSP_TY")
  export const REDSUN_EXPERIMENTAL_LSP_TOOL = REDSUN_EXPERIMENTAL || truthy("REDSUN_EXPERIMENTAL_LSP_TOOL")

  function truthy(key: string) {
    const value = process.env[key]?.toLowerCase()
    return value === "true" || value === "1"
  }

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}
