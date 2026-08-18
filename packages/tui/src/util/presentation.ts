// REDSUN: the exit epilogue is the product name and the two lines that let you
// pick the session back up. The gradient wordmark belongs to the new-session
// screen, where it has a frame to sit in; printed into scrollback after the
// alternate screen is gone it is four rows of noise above the one line that
// matters.
const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    "redsun",
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}redsun -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
