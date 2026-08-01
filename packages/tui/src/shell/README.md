# Dense shell

The default Redsun TUI: a native-scrollback UI in the style of Claude Code's
launch/scrollback model with pi `--alt` density. The classic fullscreen UI is
still available behind `redsun --classic` or `tui.ui: "classic"`.

Everything here is additive and Redsun-specific. Retained OpenCode files carry
exactly seven marked `REDSUN DENSE` hooks:

| File | Hook |
| --- | --- |
| `app.tsx` | renderer options/teardown branch in `run()`; dense early return in `App` |
| `config/index.tsx` | `ui` schema field (dense default) |
| `ui/dialog.tsx` | the floating overlay is classic-only |
| `ui/dialog-select.tsx` | dense early return into `InlineSelect` |
| `component/prompt/index.tsx` | dense chrome variant; optional `PromptRef.autocomplete` and `PromptRef.rows` |
| `component/command-bar.tsx` | `variant="dense"` (in-flow bar) |
| `../../redsun/src/cli/cmd/tui.ts` | `--classic` flag |

## How it renders

The renderer runs in OpenTUI's `split-footer` screen mode with
`externalOutputMode: "capture-stdout"` — the same mechanism `redsun --mini`
uses in production. The Solid tree paints only the pinned footer region (the
dock); finished transcript rows are committed into the terminal's own
scrollback, so scrolling, selecting and copying are the terminal's job.

- `boot.ts` — renderer options, the startup full-viewport takeover, and the
  ordered shutdown (capture→passthrough, split-footer→main-screen, destroy).
- `scrollback/` — `StreamSurface` (progressive commit of a growing block) and
  the one-shot writers. **Writers render outside the app's Solid context**, so
  they take theme/width/formatters as plain arguments — no context hooks.
- `transcript/` — `blocks.ts` derives an ordered, prefix-stable block list from
  the sync store; `committer.ts` walks it with a strict cursor; `tools.tsx`
  holds the 14 dense tool writers; `replay.ts` rebuilds everything when
  committed rows stop being valid (resize, revert/redo, session switch).
- `dock/` — the pinned footer: live tail, queued prompts, status row, notice,
  subagent strip, the active view (inline dialog / permission / question /
  prompt), and the two-line footer. `height.ts` declares each view's rows
  rather than measuring them.
- `session-lifecycle.ts` / `session-commands.tsx` — the non-visual half of
  `routes/session/index.tsx`, which dense never mounts: session loading and the
  session command set.

`writeToScrollback` throws outside split-footer + capture-stdout, so all
transcript work is gated on `scrollbackActive()` and stays inert under test
renderers.

## Plugin slots

The `TuiHostSlotMap` type is unchanged and every slot still has a host:

| Slot | Dense host |
| --- | --- |
| `home_logo`, `home_prompt`, `home_prompt_right`, `home_top`, `home_bottom` | `home.tsx`, unchanged |
| `session_prompt`, `session_prompt_right` | the dock's prompt view |
| `app`, `app_bottom` | `index.tsx`, constrained to the dock's height |
| `sidebar_title`, `sidebar_content`, `sidebar_footer` | `dock/overview.tsx`, opened by `session.sidebar.toggle` |

Dense draws no sidebar column, so the sidebar slots moved into the session
overview dialog rather than being dropped. Plugins that assume a permanently
visible sidebar will render only while the overview is open. The overview takes
the whole viewport and lays its slots out in flow — a `scrollbox` does not
render inside the dock's dialog host, so content taller than the screen clips.

## Deliberate differences from classic

- **No mouse capture.** Native terminal select/copy is worth more than mouse
  targets; every mouse affordance has a keyboard equivalent.
- **No transcript scrolling commands.** `session.page.up`, `session.line.down`,
  `session.first`, `session.message.next` and friends are not registered —
  native scrollback replaces them. They still exist in `--classic`.
- **No render toggles.** Timestamps, code concealment, tool details, the
  scrollbar and generic tool output configure a scrollbox dense does not draw.
- **Committed rows are immutable.** A goal verdict that arrives after its turn
  summary was written shows only in the dock; a revert replays instead of
  rewriting in place.
- **Running tools are not in scrollback.** They commit once settled; the dock's
  live tail covers the gap.
- **Collapsible runs hold their commit.** Consecutive read/grep/glob calls merge
  into one block that stays uncommitted until the run closes.

## `--mini`

`redsun --mini` (`packages/redsun/src/cli/cmd/run/`) keeps its own copy of the
progressive-commit machinery. The dense shell was modelled on it, and the two
could share `scrollback/stream-surface.ts`, but they are not the same product:
`--mini` is a non-interactive run renderer with its own footer, splash and
replay transport, and pointing it at the TUI package would make the run command
depend on TUI internals for no user-visible gain. The duplication is small and
deliberate; revisit it only if the commit discipline needs to change in both.
