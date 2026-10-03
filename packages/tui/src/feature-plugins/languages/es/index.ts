import { Plugin } from "@opencode/plugin/tui"
import messages from "./messages.json"

export default Plugin.define({
  id: "redsun.language.es",
  setup(context) {
    context.i18n.register({ locale: "es", name: "Spanish", nativeName: "Español", catalogs: { tui: messages } })
  },
})
