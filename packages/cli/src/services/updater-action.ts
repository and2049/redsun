export type Policy = "disable" | "notify" | "auto"
export type Action = "none" | "notify" | "auto"

const maximumComponent = "9007199254740991"
const versionPattern =
  /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
// Date-based release tags: vYY-M-D.N (e.g. v26-8-28.0). N is the same-day index.
// Month, day, and index carry no leading zeros to match the workflow output.
const datePattern = /^v?([0-9]{2})-([0-9]{1,2})-([0-9]{1,2})\.([0-9]+)$/

type Release =
  | { kind: "semver"; major: string; core: string; prerelease: string[] }
  | { kind: "date"; year: string; month: string; day: string; index: string }

export function action(current: string, latest: string, policy: Policy): Action {
  if (policy === "disable") return "none"
  const currentVersion = parseReleaseVersion(current)
  const latestVersion = parseReleaseVersion(latest)
  if (!currentVersion || !latestVersion || currentVersion.kind !== latestVersion.kind) return "none"
  if (sameRelease(currentVersion, latestVersion)) return "none"
  return policy
}

export function parseReleaseVersion(input: string): Release | undefined {
  if (input.length > 256) return
  const trimmed = input.trim()
  const date = trimmed.match(datePattern)
  if (date) {
    const [, year, month, day, index] = date
    if ([month, day, index].some(hasLeadingZero)) return
    const monthNumber = Number(month)
    const dayNumber = Number(day)
    if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return
    return { kind: "date", year, month, day, index }
  }
  const match = trimmed.match(versionPattern)
  if (!match) return
  if ([match[1], match[2], match[3]].some(invalidComponent)) return
  if (
    match[4]
      ?.split(".")
      .some((identifier) => identifier.length > 1 && identifier.startsWith("0") && /^[0-9]+$/.test(identifier))
  )
    return
  return {
    kind: "semver",
    major: match[1],
    core: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: match[4]?.split(".") ?? [],
  }
}

function sameRelease(current: Release, latest: Release): boolean {
  if (current.kind === "date" && latest.kind === "date") {
    return (
      current.year === latest.year &&
      current.month === latest.month &&
      current.day === latest.day &&
      current.index === latest.index
    )
  }
  if (current.kind === "semver" && latest.kind === "semver") {
    if (current.core !== latest.core || current.prerelease.length !== latest.prerelease.length) return false
    return current.prerelease.every((identifier, index) => {
      const other = latest.prerelease[index]
      if (identifier === other) return true
      // semver compares oversized numeric prerelease identifiers after numeric coercion.
      return /^[0-9]+$/.test(identifier) && /^[0-9]+$/.test(other) && Number(identifier) === Number(other)
    })
  }
  return false
}

function hasLeadingZero(value: string) {
  return value.length > 1 && value.startsWith("0")
}

function invalidComponent(value: string) {
  if (value.length > 1 && value.startsWith("0")) return true
  if (value.length !== maximumComponent.length) return value.length > maximumComponent.length
  return value > maximumComponent
}
