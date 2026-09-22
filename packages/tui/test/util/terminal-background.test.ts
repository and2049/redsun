import { describe, expect, test } from "bun:test"
import { RGBA, type CliRenderer } from "@opentui/core"
import { createTerminalBackground, resumeTerminal, suspendTerminal } from "../../src/util/terminal-background"

function setup() {
  const output: string[] = []
  let resolve!: (value: Awaited<ReturnType<CliRenderer["getPalette"]>>) => void
  const palette = new Promise<Awaited<ReturnType<CliRenderer["getPalette"]>>>((done) => (resolve = done))
  const renderer = {
    getPalette: () => palette,
    suspend: () => output.push("suspend"),
    resume: () => output.push("resume"),
  }
  const background = createTerminalBackground(renderer, (sequence) => output.push(sequence))
  return {
    output,
    background,
    renderer,
    async reply(color: string | null = "#123456") {
      resolve({ defaultBackground: color } as Awaited<ReturnType<CliRenderer["getPalette"]>>)
      await palette
    },
  }
}

const osc = (color: string) => `\x1b]11;${color}\x1b\\`

describe("terminal background", () => {
  test("captures the original before applying the latest theme and restores on disable", async () => {
    const { background, output, reply } = setup()
    background.update("#282828")
    background.update("#eeeeee")
    expect(output).toEqual([])
    await reply()
    expect(output).toEqual([osc("#eeeeee")])
    background.update(undefined)
    expect(output.at(-1)).toBe(osc("#123456"))
    background.update("#282828")
    background.dispose()
    expect(output.slice(-2)).toEqual([osc("#282828"), osc("#123456")])
  })

  test("restores before handoff and reapplies the latest theme after resume", async () => {
    const { background, output, renderer, reply } = setup()
    background.update("#282828")
    await reply()
    suspendTerminal(renderer)
    background.update("#eeeeee")
    expect(output.slice(-2)).toEqual([osc("#123456"), "suspend"])
    resumeTerminal(renderer)
    expect(output.slice(-2)).toEqual(["resume", osc("#eeeeee")])
    background.dispose()
  })

  test("late palette replies cannot recolor a disposed or disabled UI", async () => {
    for (const dispose of [true, false]) {
      const { background, output, reply } = setup()
      background.update("#282828")
      if (dispose) background.dispose()
      else background.update(undefined)
      await reply()
      expect(output).toEqual([])
    }
  })

  test("a palette reply during suspension waits until resume", async () => {
    const { background, output, renderer, reply } = setup()
    background.update("#282828")
    suspendTerminal(renderer)
    await reply()
    expect(output).toEqual(["suspend"])
    resumeTerminal(renderer)
    expect(output).toEqual(["suspend", "resume", osc("#282828")])
    background.dispose()
  })

  test("leaves an unresponsive terminal and inherited backgrounds alone", async () => {
    const { background, output, reply } = setup()
    background.update("#282828")
    await reply(null)
    background.dispose()
    expect(output).toEqual([])

    const inherited = setup()
    inherited.background.update("#282828")
    await inherited.reply()
    inherited.background.update(RGBA.defaultBackground())
    expect(inherited.output.at(-1)).toBe(osc("#123456"))
    inherited.background.update(RGBA.fromInts(0, 0, 0, 0))
    expect(inherited.output).toHaveLength(2)
    inherited.background.dispose()
  })
})
