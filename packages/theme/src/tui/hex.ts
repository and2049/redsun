import type { RGBA } from "@opentui/core"

export function colorToHex(color: RGBA): string {
  const byte = (value: number) =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${color.a < 1 ? byte(color.a) : ""}`
}
