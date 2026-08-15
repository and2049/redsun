# Dense shell

The dense UI is the only interface. It runs a fullscreen architecture —
one fixed-size frame, a scrollbox transcript, floating overlays.

## History

The shell originally implemented a native-scrollback design: the renderer ran
in OpenTUI's split-footer screen mode with `externalOutputMode:
"capture-stdout"`, the Solid tree painted only a pinned bottom dock, and
finished transcript blocks were committed into the terminal's own scrollback.
That bought native scrolling/select/copy, but transient tall views (pickers,
`:` command mode, `/` autocomplete, permissions) had no rows to grow into:
committed scrollback cannot be repainted, so every open/close either scrolled
the transcript or left gaps above the dock. Three generations of fixes
(offset pinning, unconditional replay resets, cover-and-restore overlays)
each removed a class of gap and exposed the next. The fullscreen pivot
removes the constraint itself: when the whole viewport is a live frame,
overlays are absolutely-positioned boxes that reflow nothing — the layout
literally cannot move when a menu opens. The scrollback machinery lives in
git history up to `feat(tui): overlay tall dock views over the transcript,
replay on close` if it is ever needed again.

## Layout

| Where | What |
| --- | --- |
| `src/shell/index.tsx` | `DenseApp` root: session route + dense home + in-flow `CommandBar` as the frame's last row |
| `src/shell/home.tsx` | Dense home: gradient logo, hint row, prompt in dense chrome |
| `component/prompt/*` | Dense prompt chrome (bordered box, agent-coloured `❯`), opaque autocomplete base |
| `component/command-bar.tsx` | Participates in column flow instead of floating over the last row |
| `app.tsx` | Mounts `DenseApp`; the renderer boot is shared |

Dialogs and selects float in the shared overlay (`ui/dialog.tsx`), Claude Code
style: they paint over the transcript and close without moving it.
