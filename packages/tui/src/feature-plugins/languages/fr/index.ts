import { Plugin } from "@opencode/plugin/tui"
import messages from "./messages.json"

export default Plugin.define({
  id: "redsun.language.fr",
  setup(context) {
    context.i18n.register({ locale: "fr", name: "French", nativeName: "Français", catalogs: { tui: messages } })
  },
})
