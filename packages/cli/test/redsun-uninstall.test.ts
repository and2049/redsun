import { expect, test } from "bun:test"
import { cleanShellConfig } from "../src/commands/handlers/uninstall"

test("uninstall removes redsun shell entries while preserving other installations", () => {
  const content = [
    "# opencode",
    'export PATH="$HOME/.opencode/bin:$PATH"',
    "# redsun",
    'export PATH="$HOME/.redsun/bin:$PATH"',
    "fish_add_path $HOME/.redsun/bin",
    'export PATH="$HOME/tools:$PATH"',
    "# redsun",
    "echo keep this unrelated note",
    "",
  ].join("\n")
  expect(cleanShellConfig(content)).toBe(
    [
      "# opencode",
      'export PATH="$HOME/.opencode/bin:$PATH"',
      'export PATH="$HOME/tools:$PATH"',
      "# redsun",
      "echo keep this unrelated note",
      "",
    ].join("\n"),
  )
})
