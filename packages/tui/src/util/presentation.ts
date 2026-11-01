const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

export type SessionEpilogue = { readonly title: string; readonly sessionID?: string }

// Printed after the TUI closes. The wordmark is new-session chrome; scrollback gets the name alone.
export function epilogue(input: { readonly session?: SessionEpilogue; readonly updatedVersion?: string }) {
  if (!input.session && !input.updatedVersion) return
  const row = (label: string, value: string) => `  ${dim}${label.padEnd(10, " ")}${reset}${bold}${value}${reset}`
  return [
    "redsun",
    "",
    ...(input.updatedVersion
      ? [`  ${dim}Run ${reset}${bold}redsun${reset}${dim} to use ${reset}${bold}${input.updatedVersion}${reset}`, ""]
      : []),
    ...(input.session
      ? [row("Session", input.session.title), row("Continue", `redsun -s ${input.session.sessionID}`), ""]
      : []),
  ].join("\n")
}
