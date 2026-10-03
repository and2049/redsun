type OklchColor = {
  l: number
  c: number
  h: number
}

function srgbToLinear(value: number) {
  if (value <= 0.04045) return value / 12.92
  return Math.pow((value + 0.055) / 1.055, 2.4)
}

export function rgbToOklch(red: number, green: number, blue: number): OklchColor {
  const linearRed = srgbToLinear(red)
  const linearGreen = srgbToLinear(green)
  const linearBlue = srgbToLinear(blue)
  const lRoot = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue)
  const mRoot = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue)
  const sRoot = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue)
  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot
  const b = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
  const chroma = Math.sqrt(a * a + b * b)
  const angle = Math.atan2(b, a) * (180 / Math.PI)
  return { l: lightness, c: chroma, h: angle < 0 ? angle + 360 : angle }
}
