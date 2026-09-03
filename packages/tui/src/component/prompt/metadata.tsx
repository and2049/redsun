import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

export const WORKER_UNSET = "worker model not set"

export type WorkerDisplay = { model: string; provider: string; variant?: string }

export function PromptMetadataRow(props: {
  mode: "normal" | "shell"
  agent?: string
  auto: boolean
  model: string
  provider: string
  variant?: string
  /** REDSUN: compose worker readout; `null` means compose is active with no worker set. */
  worker?: WorkerDisplay | null
  muted: boolean
  highlight: RGBA
  agentAlpha: number
  modelAlpha: number
  variantAlpha: number
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => {
    if (props.mode === "shell") return { agent: props.agent ?? "Shell", model: "" }
    return promptMetadataLayout({
      width: Math.max(0, dimensions().width - (dimensions().width < 44 ? 9 : 13)),
      terminalWidth: dimensions().width,
      agent: props.agent ?? "",
      auto: props.auto,
      model: props.model,
      provider: props.provider,
      variant: props.variant,
      worker: props.worker,
    })
  })

  return (
    <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
      <Show
        when={(props.mode === "shell" || props.agent) && (layout().agent || layout().model)}
        fallback={<box height={1} />}
      >
        <Show when={layout().agent}>
          {(agent) => <text fg={fade(props.highlight, props.agentAlpha)}>{agent()}</text>}
        </Show>
        <Show when={props.mode === "normal" && layout().auto}>
          <text fg={fade(theme.text.subdued, props.agentAlpha)}>auto</text>
        </Show>
        <Show when={props.mode === "normal" && layout().model}>
          <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Show when={layout().agent}>
              <text fg={fade(theme.text.subdued, props.modelAlpha)}>·</text>
            </Show>
            <text
              flexShrink={1}
              minWidth={0}
              wrapMode="none"
              truncate
              fg={fade(props.muted ? theme.text.subdued : theme.text.default, props.modelAlpha)}
            >
              {layout().model}
            </text>
            <Show when={layout().provider}>
              {(provider) => (
                <text flexShrink={0} fg={fade(theme.text.subdued, props.modelAlpha)}>
                  {provider()}
                </text>
              )}
            </Show>
            <Show when={layout().variant}>
              {(variant) => (
                <>
                  <text fg={fade(theme.text.subdued, props.variantAlpha)}>·</text>
                  <text
                    fg={fade(theme.text.feedback.warning.default, props.variantAlpha)}
                    attributes={TextAttributes.BOLD}
                  >
                    {variant()}
                  </text>
                </>
              )}
            </Show>
            <Show when={layout().worker !== undefined}>
              <text fg={fade(theme.text.subdued, props.modelAlpha)}>·</text>
              <Show
                when={layout().worker}
                fallback={
                  <text flexShrink={0} fg={fade(theme.text.feedback.warning.default, props.modelAlpha)}>
                    {WORKER_UNSET}
                  </text>
                }
              >
                {(worker) => (
                  <>
                    <text
                      flexShrink={1}
                      minWidth={0}
                      wrapMode="none"
                      truncate
                      fg={fade(props.muted ? theme.text.subdued : theme.text.default, props.modelAlpha)}
                    >
                      {worker().model}
                    </text>
                    <Show when={worker().provider}>
                      {(provider) => (
                        <text flexShrink={0} fg={fade(theme.text.subdued, props.modelAlpha)}>
                          {provider()}
                        </text>
                      )}
                    </Show>
                    <Show when={worker().variant}>
                      {(variant) => (
                        <>
                          <text fg={fade(theme.text.subdued, props.variantAlpha)}>·</text>
                          <text
                            fg={fade(theme.text.feedback.warning.default, props.variantAlpha)}
                            attributes={TextAttributes.BOLD}
                          >
                            {variant()}
                          </text>
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function fade(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

type Layout = {
  agent?: string
  auto?: boolean
  model: string
  provider?: string
  variant?: string
  worker?: WorkerDisplay | null
}

function promptMetadataLayout(input: {
  width: number
  terminalWidth: number
  agent: string
  auto?: boolean
  model: string
  provider: string
  variant?: string
  worker?: WorkerDisplay | null
}) {
  const agent = input.terminalWidth < 44 ? undefined : input.agent
  const provider = input.terminalWidth < 44 ? "" : input.provider
  const worker = input.terminalWidth < 70 ? undefined : input.worker
  const shortProvider = provider.split(" / ").at(-1) ?? provider
  const shortWorker = worker ? { ...worker, provider: worker.provider.split(" / ").at(-1) ?? worker.provider } : worker
  const bareWorker = worker ? { ...worker, provider: "" } : worker
  const candidates: Layout[] = [
    { agent, auto: input.auto, model: input.model, provider, variant: input.variant, worker },
    { agent, model: input.model, provider, variant: input.variant, worker },
    { agent, model: input.model, provider: shortProvider, variant: input.variant, worker: shortWorker },
    { agent, model: input.model, variant: input.variant, worker: bareWorker },
    { agent, model: input.model, variant: input.variant },
  ]
  const fit = candidates.find((candidate) => stringWidth(text(candidate)) <= input.width)
  if (fit) return fit

  const prefix = agent ? `${agent} · ` : ""
  const suffix = input.variant ? ` · ${input.variant}` : ""
  return {
    agent,
    model: Locale.truncateWidth(
      input.model,
      Math.max(9, input.width - stringWidth(prefix) - stringWidth(suffix)),
    ).replace(/\s+…$/, "…"),
    variant: input.variant,
  }
}

function text(input: Layout) {
  const worker =
    input.worker === undefined
      ? []
      : input.worker === null
        ? ["·", WORKER_UNSET]
        : [
            "·",
            input.worker.model,
            ...(input.worker.provider ? [input.worker.provider] : []),
            ...(input.worker.variant ? ["·", input.worker.variant] : []),
          ]
  return [
    ...(input.agent ? [input.agent] : []),
    ...(input.auto ? ["auto"] : []),
    ...(input.model ? [...(input.agent ? ["·"] : []), input.model] : []),
    ...(input.provider ? [input.provider] : []),
    ...(input.variant ? ["·", input.variant] : []),
    ...worker,
  ].join(" ")
}
