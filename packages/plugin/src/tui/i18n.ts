export type Values = Readonly<Record<string, string | number>>

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other"

export type Message =
  | string
  | {
      readonly plural: string
      readonly forms: Readonly<Partial<Record<PluralCategory, string>>> & { readonly other: string }
    }

export type Catalog = Readonly<Record<string, Message>>

export interface LanguageContribution {
  readonly locale: string
  readonly name?: string
  readonly nativeName?: string
  readonly fallback?: string
  readonly catalogs: Readonly<Record<string, Catalog>>
}

export interface LanguageInfo {
  readonly locale: string
  readonly name: string
  readonly nativeName: string
  readonly available: boolean
  readonly providers: readonly string[]
}

export interface TranslationDiagnostic {
  readonly plugin: string
  readonly locale: string
  readonly key: string
  readonly message: string
}

export interface I18n {
  readonly register: (contribution: LanguageContribution) => () => void
  readonly locale: () => string
  readonly languages: () => readonly LanguageInfo[]
  readonly diagnostics: () => readonly TranslationDiagnostic[]
  readonly t: (key: string, values?: Values) => string
}
