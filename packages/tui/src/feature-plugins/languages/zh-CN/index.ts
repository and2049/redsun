import { Plugin } from "@opencode/plugin/tui"
import messages from "./messages.json"

export default Plugin.define({
  id: "redsun.language.zh-CN",
  setup(context) {
    context.i18n.register({
      locale: "zh-CN",
      name: "Simplified Chinese",
      nativeName: "简体中文",
      catalogs: { tui: messages },
    })
  },
})
