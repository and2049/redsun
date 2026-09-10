import { createMemo } from "solid-js"
import { useTuiPaths } from "../../context/runtime"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { abbreviateHome } from "../../util/path-format"
import { SessionQuestion } from "./permission"
import { usePromptMove } from "../../component/prompt/move"
import { useLanguage } from "../../i18n"

export function SessionLocationMissing(props: { directory: string; projectID: string; sessionID: string }) {
  const move = usePromptMove({ projectID: () => props.projectID, sessionID: () => props.sessionID })
  return <SessionLocationUnavailable directory={props.directory} onMove={move.open} />
}

export function SessionLocationUnavailable(props: { directory: string; onMove: () => void }) {
  const paths = useTuiPaths()
  const theme = useTheme("elevated")
  const language = useLanguage()
  const directory = createMemo(() => Locale.truncateMiddle(abbreviateHome(props.directory, paths.home), 72))

  return (
    <SessionQuestion
      id="session.location-missing"
      group={language.t("Session recovery")}
      choicesLabel={language.t("Recovery actions")}
      instance={props.directory}
      title={language.t("Session location unavailable")}
      body={
        <box paddingLeft={1} gap={1}>
          <text fg={theme.text.subdued}>{directory()}</text>
          <text fg={theme.text.default}>{language.t("Choose another directory to continue this session.")}</text>
        </box>
      }
      options={{ move: language.t("Choose directory") }}
      onSelect={props.onMove}
    />
  )
}
