// Progressive-commit engine for one streaming transcript block.
//
// Generalizes the retained-surface machinery of `redsun --mini`
// (packages/redsun/src/cli/cmd/run/scrollback.surface.ts) into a single-block
// primitive: content still arriving is laid out in a retained scrollback
// surface, and only rows that can no longer change are committed to native
// terminal scrollback.
//
// Commit discipline (proven by --mini in production):
// - text/code: commit all rows except the last (the last row may still grow);
//   on finish, commit everything.
// - markdown: commit only blocks below the renderable's `_stableBlockCount`
//   while streaming; on finish, commit all blocks.
import {
  CodeRenderable,
  MarkdownRenderable,
  TextRenderable,
  getTreeSitterClient,
  type CliRenderer,
  type RGBA,
  type ScrollbackSurface,
  type SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core"
import { spacerWriter } from "./writers"

export type StreamBody =
  | { type: "text"; fg: RGBA; attributes?: number }
  | { type: "code"; fg: RGBA; syntaxStyle: SyntaxStyle; filetype?: string }
  | { type: "markdown"; fg: RGBA; syntaxStyle: SyntaxStyle }

export type StreamSurfaceOptions = {
  startOnNewLine?: boolean
  // Blank rows to write immediately before this block's first committed rows.
  // Deferred so an empty block never produces a stray spacer.
  leadingSpacerRows?: number
  treeSitterClient?: TreeSitterClient
}

function commitMarkdownBlocks(input: {
  surface: ScrollbackSurface
  renderable: MarkdownRenderable
  startBlock: number
  endBlockExclusive: number
  trailingNewline: boolean
  beforeCommit?: () => void
}) {
  if (input.endBlockExclusive <= input.startBlock) {
    return false
  }

  const first = input.renderable._blockStates[input.startBlock]
  const last = input.renderable._blockStates[input.endBlockExclusive - 1]
  if (!first || !last) {
    return false
  }

  const next = input.renderable._blockStates[input.endBlockExclusive]
  const start = first.renderable.y
  const end = next ? next.renderable.y : last.renderable.y + last.renderable.height

  input.beforeCommit?.()
  input.surface.commitRows(start, end, {
    trailingNewline: input.trailingNewline,
  })
  return true
}

export class StreamSurface {
  private surface: ScrollbackSurface
  private renderable: TextRenderable | CodeRenderable | MarkdownRenderable
  private content = ""
  private committedRows = 0
  private committedBlocks = 0
  private pendingSpacerRows: number
  private finished = false
  private destroyed = false
  // True once any rows were committed to scrollback.
  public wrote = false

  constructor(
    private renderer: CliRenderer,
    private body: StreamBody,
    options: StreamSurfaceOptions = {},
  ) {
    this.pendingSpacerRows = options.leadingSpacerRows ?? 0
    this.surface = renderer.createScrollbackSurface({
      startOnNewLine: options.startOnNewLine ?? true,
    })
    const treeSitterClient = options.treeSitterClient ?? getTreeSitterClient()
    this.renderable =
      body.type === "text"
        ? new TextRenderable(this.surface.renderContext, {
            content: "",
            width: "100%",
            wrapMode: "word",
            fg: body.fg,
            attributes: body.attributes,
          })
        : body.type === "code"
          ? new CodeRenderable(this.surface.renderContext, {
              content: "",
              filetype: body.filetype,
              syntaxStyle: body.syntaxStyle,
              width: "100%",
              wrapMode: "word",
              drawUnstyledText: false,
              streaming: true,
              fg: body.fg,
              treeSitterClient,
            })
          : new MarkdownRenderable(this.surface.renderContext, {
              content: "",
              syntaxStyle: body.syntaxStyle,
              width: "100%",
              streaming: true,
              internalBlockMode: "top-level",
              tableOptions: { widthMode: "content" },
              fg: body.fg,
              treeSitterClient,
            })
    this.surface.root.add(this.renderable)
  }

  get isFinished(): boolean {
    return this.finished
  }

  setContent(content: string): void {
    this.content = content
  }

  appendContent(delta: string): void {
    this.content += delta
  }

  private flushPendingSpacer(): void {
    if (this.pendingSpacerRows === 0) {
      return
    }

    this.pendingSpacerRows = 0
    this.renderer.writeToScrollback(spacerWriter())
  }

  // Commits every row/block that can no longer change. Pass done=true to
  // commit the remainder. Returns true when new rows were committed.
  private async flush(done: boolean, trailingNewline: boolean): Promise<boolean> {
    if (this.destroyed || this.finished) {
      return false
    }

    // A surface that never received content commits nothing (and its deferred
    // leading spacer never fires).
    if (this.content.length === 0) {
      return false
    }

    if (this.body.type === "text") {
      const renderable = this.renderable as TextRenderable
      renderable.content = this.content
      this.surface.render()
      const targetRows = done ? this.surface.height : Math.max(this.committedRows, this.surface.height - 1)
      if (targetRows <= this.committedRows) {
        return false
      }

      this.flushPendingSpacer()
      this.surface.commitRows(this.committedRows, targetRows, {
        trailingNewline: done && targetRows === this.surface.height ? trailingNewline : false,
      })
      this.committedRows = targetRows
      this.wrote = true
      return true
    }

    if (this.body.type === "code") {
      const renderable = this.renderable as CodeRenderable
      renderable.content = this.content
      renderable.streaming = !done
      await this.surface.settle()
      const targetRows = done ? this.surface.height : Math.max(this.committedRows, this.surface.height - 1)
      if (targetRows <= this.committedRows) {
        return false
      }

      this.flushPendingSpacer()
      this.surface.commitRows(this.committedRows, targetRows, {
        trailingNewline: done && targetRows === this.surface.height ? trailingNewline : false,
      })
      this.committedRows = targetRows
      this.wrote = true
      return true
    }

    const renderable = this.renderable as MarkdownRenderable
    renderable.content = this.content
    renderable.streaming = !done
    await this.surface.settle()
    const targetBlockCount = done ? renderable._blockStates.length : renderable._stableBlockCount
    if (targetBlockCount <= this.committedBlocks) {
      return false
    }

    if (
      commitMarkdownBlocks({
        surface: this.surface,
        renderable,
        startBlock: this.committedBlocks,
        endBlockExclusive: targetBlockCount,
        trailingNewline: done && targetBlockCount === renderable._blockStates.length ? trailingNewline : false,
        beforeCommit: () => this.flushPendingSpacer(),
      })
    ) {
      this.committedBlocks = targetBlockCount
      this.wrote = true
      return true
    }

    return false
  }

  // Progressive commit while the block is still streaming.
  async stream(): Promise<boolean> {
    return this.flush(false, false)
  }

  // Commits the remainder and destroys the retained surface.
  async finish(trailingNewline = false): Promise<boolean> {
    if (this.destroyed || this.finished) {
      return false
    }

    try {
      return await this.flush(true, trailingNewline)
    } finally {
      this.finished = true
      this.destroySurface()
    }
  }

  private destroySurface(): void {
    if (!this.surface.isDestroyed) {
      this.surface.destroy()
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.destroySurface()
  }
}
