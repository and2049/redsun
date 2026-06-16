import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { ExtensionInstall } from "../../extension/install"
import { UI } from "../ui"
import { bootstrap } from "../bootstrap"

export const InstallCommand = cmd({
  command: "install [specifier]",
  describe: "install an extension",
  builder: (yargs: Argv) => {
    return yargs.positional("specifier", {
      type: "string",
      describe: "Extension specifier (npm:package, npm:package@version, file:./path)",
    })
  },
  handler: async (args) => {
    if (!args.specifier) {
      UI.error("Usage: redsun install <npm:package | file:./path>")
      process.exit(1)
    }

    await bootstrap(process.cwd(), async () => {
      const result = await ExtensionInstall.install(args.specifier!)
      if (result.success) {
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓" + UI.Style.TEXT_NORMAL + ` ${result.message}`)
      } else {
        UI.error(result.message)
        process.exit(1)
      }
    })
  },
})
