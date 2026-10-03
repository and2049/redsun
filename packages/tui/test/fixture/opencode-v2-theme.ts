import { Schema } from "effect"
import { ThemeDocument, type ModeDefinition } from "@opencode/theme/tui"
import source from "./opencode-v2-theme.json" with { type: "json" }

// Upstream's native V2 theme. Redsun ships only flat V1 palettes, so the V2
// resolution tests read this copy instead of a built-in theme.
type Complete = ThemeDocument & { readonly light: ModeDefinition; readonly dark: ModeDefinition }

let decoded: Complete | undefined

export function getOpenCodeTheme(): Complete {
  decoded ??= Schema.decodeUnknownSync(ThemeDocument)(source) as Complete
  return decoded
}
