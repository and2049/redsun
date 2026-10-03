import { parseColor, rgbToHex, RGBA, type CliRenderer, type ColorInput } from "@opentui/core"

const backgrounds = new WeakMap<object, ReturnType<typeof createTerminalBackground>>()

// Keep OSC writes separate from the cell background: transparent/default-color
// themes must continue to inherit the terminal's own background.
export function createTerminalBackground(
  renderer: Pick<CliRenderer, "getPalette">,
  write: (sequence: string) => void,
) {
  let original: string | undefined
  let desired: string | undefined
  let applied = false
  let suspended = false
  let disposed = false
  let queried = false
  let gain = 1

  const set = (color: string) => write(`\x1b]11;${color}\x1b\\`)
  const restore = () => {
    if (!applied || !original) return
    set(original)
    applied = false
  }
  const apply = () => {
    if (disposed || suspended || !original) return
    if (!desired) return restore()
    const color = parseColor(desired)
    set(gain === 1 ? desired : rgbToHex(RGBA.fromValues(color.r * gain, color.g * gain, color.b * gain)))
    applied = true
  }

  const background = {
    setGain(value: number) {
      gain = value
      apply()
    },
    update(color: ColorInput | undefined) {
      if (disposed) return
      const rgba = color === undefined ? undefined : parseColor(color)
      desired = rgba && rgba.a === 1 && rgba.intent === "rgb" ? rgbToHex(rgba) : undefined
      if (desired && !queried) {
        queried = true
        // Do not change an unresponsive terminal: we need its original color
        // before taking ownership, including any color set by a parent TUI.
        void renderer
          .getPalette({ size: 16 })
          .then((palette) => {
            original = palette.defaultBackground ?? undefined
            apply()
          })
          .catch(() => {})
      }
      apply()
    },
    suspend() {
      suspended = true
      restore()
    },
    resume() {
      suspended = false
      apply()
    },
    dispose() {
      restore()
      disposed = true
      backgrounds.delete(renderer)
    },
  }
  backgrounds.set(renderer, background)
  return background
}

export function suspendTerminal(renderer: Pick<CliRenderer, "suspend">) {
  backgrounds.get(renderer)?.suspend()
  renderer.suspend()
}

export function resumeTerminal(renderer: Pick<CliRenderer, "resume">) {
  renderer.resume()
  backgrounds.get(renderer)?.resume()
}

export function setTerminalBackgroundGain(renderer: object, gain: number) {
  backgrounds.get(renderer)?.setGain(gain)
}
