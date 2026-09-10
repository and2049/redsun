import { Plugin } from "@opencode/plugin/tui"
import messages from "./messages.json"

export default Plugin.define({
  id: "redsun.language.ko",
  setup(context) {
    context.i18n.register({ locale: "ko", name: "Korean", nativeName: "한국어", catalogs: { tui: messages } })
  },
})
