// Static scrollback writers for the dense shell.
//
// Each writer renders once into native terminal scrollback via
// createScrollbackWriter; committed rows are final and never repainted.
// Styling reads the TUI theme at write time — theme switches only affect
// rows committed afterwards (scrollback is immutable by design).
import { RGBA, TextRenderable, type ScrollbackRenderContext, type ScrollbackWriter } from "@opentui/core"
import { createScrollbackWriter } from "@opentui/solid"
import { For } from "solid-js"
import type { Theme } from "../../theme"

// One blank row between transcript blocks.
export function spacerWriter(): ScrollbackWriter {
  return (ctx: ScrollbackRenderContext) => ({
    root: new TextRenderable(ctx.renderContext, {
      width: Math.max(1, Math.trunc(ctx.width)),
      height: 1,
      content: "",
    }),
    width: Math.max(1, Math.trunc(ctx.width)),
    height: 1,
    startOnNewLine: true,
    trailingNewline: true,
  })
}

// A promoted user message: `❯ text`.
export function userWriter(input: { text: string; theme: Theme }): ScrollbackWriter {
  return createScrollbackWriter(
    () => (
      <box width="100%">
        <text width="100%" wrapMode="word">
          <span style={{ fg: input.theme.primary, bold: true }}>❯ </span>
          <span style={{ fg: input.theme.text }}>{input.text}</span>
        </text>
      </box>
    ),
    { startOnNewLine: true, trailingNewline: false },
  )
}

// Dim end-of-turn line: `▣ agent · model · duration`, with an optional goal
// verdict line when one arrived before the summary committed.
export function turnSummaryWriter(input: {
  agent: string
  model: string
  duration: string
  theme: Theme
  verdict?: { ok: boolean; impossible?: boolean; error?: boolean; reason: string }
}): ScrollbackWriter {
  const verdict = input.verdict
  const verdictColor = verdict
    ? verdict.ok
      ? input.theme.success
      : verdict.impossible || verdict.error
        ? input.theme.error
        : input.theme.warning
    : undefined
  const verdictLabel = verdict
    ? verdict.ok
      ? "✓ goal satisfied"
      : verdict.impossible
        ? "⨯ goal impossible"
        : verdict.error
          ? "⚠ goal judge error"
          : "◌ goal pending"
    : undefined
  return createScrollbackWriter(
    () => (
      <box width="100%" flexDirection="column">
        <box width="100%" height={1}>
          <text wrapMode="none" truncate>
            <span style={{ fg: input.theme.secondary }}>▣ </span>
            <span style={{ fg: input.theme.text }}>{input.agent}</span>
            <span style={{ fg: input.theme.textMuted }}>
              {" "}
              · {input.model} · {input.duration}
            </span>
          </text>
        </box>
        {verdict ? (
          <text width="100%" wrapMode="word" fg={verdictColor}>
            {verdictLabel}
            {verdict.reason ? `: ${verdict.reason}` : ""}
          </text>
        ) : null}
      </box>
    ),
    { startOnNewLine: true, trailingNewline: false },
  )
}

// Dim single-line note (collapsed reasoning, interruption records, …).
export function noteWriter(input: { text: string; theme: Theme; symbol?: string }): ScrollbackWriter {
  return createScrollbackWriter(
    () => (
      <box width="100%">
        <text width="100%" wrapMode="word" fg={input.theme.textMuted}>
          {input.symbol ? `${input.symbol} ${input.text}` : input.text}
        </text>
      </box>
    ),
    { startOnNewLine: true, trailingNewline: false },
  )
}

// Assistant error record.
export function errorWriter(input: { text: string; theme: Theme }): ScrollbackWriter {
  return createScrollbackWriter(
    () => (
      <box width="100%">
        <text width="100%" wrapMode="word" fg={input.theme.error}>
          {input.text}
        </text>
      </box>
    ),
    { startOnNewLine: true, trailingNewline: false },
  )
}

// Compact session banner committed when the home view hands off to a session:
// a small gradient wordmark plus a dim detail line.
export function bannerWriter(input: { detail: string; theme: Theme }): ScrollbackWriter {
  const word = "redsun"
  const letters = word.split("")
  return createScrollbackWriter(
    () => (
      <box width="100%" flexDirection="column">
        <box flexDirection="row">
          <text wrapMode="none">
            <span style={{ fg: input.theme.textMuted }}>▐ </span>
          </text>
          <For each={letters}>
            {(letter, index) => {
              const t = index() / Math.max(1, letters.length - 1)
              const start = input.theme.logoGradientStart
              const end = input.theme.logoGradientEnd
              const fg = RGBA.fromValues(
                start.r + (end.r - start.r) * t,
                start.g + (end.g - start.g) * t,
                start.b + (end.b - start.b) * t,
                1,
              )
              return (
                <text wrapMode="none">
                  <span style={{ fg, bold: true }}>{letter}</span>
                </text>
              )
            }}
          </For>
        </box>
        <text width="100%" wrapMode="none" truncate fg={input.theme.textMuted}>
          {input.detail}
        </text>
      </box>
    ),
    { startOnNewLine: true, trailingNewline: false },
  )
}
