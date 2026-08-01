import { afterEach, expect, test } from "bun:test"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient, createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { StreamSurface } from "../../src/shell/scrollback/stream-surface"

type ClaimedCommit = {
  snapshot: {
    height: number
    getRealCharBytes(addLineBreaks?: boolean): Uint8Array
    destroy(): void
  }
  trailingNewline: boolean
}

const decoder = new TextDecoder()
const active: TestRenderer[] = []
const styles: SyntaxStyle[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) {
    renderer.destroy()
  }
  for (const style of styles.splice(0)) {
    style.destroy()
  }
})

function claim(renderer: TestRenderer): ClaimedCommit[] {
  const queue = Reflect.get(renderer, "externalOutputQueue")
  if (!queue || typeof queue !== "object" || !("claim" in queue) || typeof queue.claim !== "function") {
    throw new Error("renderer missing external output queue")
  }

  const commits = queue.claim()
  if (!Array.isArray(commits)) {
    throw new Error("renderer external output queue returned invalid commits")
  }

  return commits as ClaimedCommit[]
}

function render(commits: ClaimedCommit[]) {
  return commits.map((commit) => decoder.decode(commit.snapshot.getRealCharBytes(true)).replace(/ +\n/g, "\n")).join("")
}

function destroy(commits: ClaimedCommit[]) {
  for (const commit of commits) {
    commit.snapshot.destroy()
  }
}

async function setup(width = 80) {
  const out = await createTestRenderer({
    width,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  const treeSitterClient = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  treeSitterClient.setMockResult({ highlights: [] })

  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
  styles.push(syntaxStyle)

  return { renderer: out.renderer, treeSitterClient, syntaxStyle }
}

test("markdown holds unstable blocks while streaming and commits all on finish", async () => {
  const out = await setup()
  const surface = new StreamSurface(
    out.renderer,
    { type: "markdown", fg: RGBA.fromInts(255, 255, 255), syntaxStyle: out.syntaxStyle },
    { treeSitterClient: out.treeSitterClient },
  )

  try {
    surface.setContent('# Sample\n\n- Item 1\n- Item 2\n\n```js\nconst message = "hello"\nconsole.log(message)\n```')
    await surface.stream()

    const progress = claim(out.renderer)
    try {
      const output = render(progress)
      expect(output).toContain("Sample")
      expect(output).toContain("Item 2")
      expect(output).not.toContain("console.log(message)")
    } finally {
      destroy(progress)
    }

    await surface.finish()

    const final = claim(out.renderer)
    try {
      const output = render(final)
      expect(output).toContain('const message = "hello"')
      expect(output).toContain("console.log(message)")
      expect(output).not.toContain("```")
    } finally {
      destroy(final)
    }
  } finally {
    surface.destroy()
  }
})

test("text commits all rows except the still-growing last row", async () => {
  const out = await setup()
  const surface = new StreamSurface(out.renderer, { type: "text", fg: RGBA.fromInts(255, 255, 255) }, {})

  try {
    surface.setContent("line one\nline two\nline three")
    await surface.stream()

    const progress = claim(out.renderer)
    try {
      const output = render(progress)
      expect(output).toContain("line one")
      expect(output).toContain("line two")
      expect(output).not.toContain("line three")
    } finally {
      destroy(progress)
    }

    surface.appendContent(" grew")
    await surface.finish()

    const final = claim(out.renderer)
    try {
      expect(render(final)).toContain("line three grew")
    } finally {
      destroy(final)
    }
  } finally {
    surface.destroy()
  }
})

test("leading spacer is deferred until the first committed rows", async () => {
  const out = await setup()

  // A surface that never produces content must not write its spacer.
  const empty = new StreamSurface(
    out.renderer,
    { type: "text", fg: RGBA.fromInts(255, 255, 255) },
    { leadingSpacerRows: 1 },
  )
  await empty.finish()
  expect(claim(out.renderer)).toHaveLength(0)
  empty.destroy()

  const surface = new StreamSurface(
    out.renderer,
    { type: "text", fg: RGBA.fromInts(255, 255, 255) },
    { leadingSpacerRows: 1 },
  )

  try {
    surface.setContent("hello world")
    await surface.finish()

    const commits = claim(out.renderer)
    try {
      expect(commits.length).toBe(2)
      expect(render([commits[0]!]).trim()).toBe("")
      expect(render([commits[1]!])).toContain("hello world")
    } finally {
      destroy(commits)
    }
  } finally {
    surface.destroy()
  }
})
