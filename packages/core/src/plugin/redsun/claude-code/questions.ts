// REDSUN: routes Claude Code's `AskUserQuestion` onto v2's question surface.
//
// The tool is gated on the `question` permission like any other (permissions.ts),
// but a *granted* question still needs somewhere to be answered. Claude Code has
// no terminal of its own here, so without this the model gets an allow and no
// answers, and the turn stalls on a question the user never saw.
//
// v2's question service is `Form.Service` — `core/src/tool/plugin/question.ts`
// is a thin tool over it — and the TUI renders any session-scoped form
// regardless of who created it. So this needs no new UI: build the same fields
// the question tool builds, ask, and hand the answers back through the SDK's
// `updatedInput`.
//
// The SDK keys answers by the full question text (verified against
// @anthropic-ai/claude-agent-sdk 0.3.223: `AskUserQuestionInput.answers` is
// "question text -> answer string; multi-select answers are comma-separated").
export * as ClaudeCodeQuestions from "./questions.js"

import type { Form } from "../../../form.js"

export const TOOL_NAME = "AskUserQuestion"

export interface Question {
  readonly question: string
  readonly header: string
  readonly multiSelect: boolean
  readonly options: readonly { readonly label: string; readonly description?: string }[]
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

/** The questions in a tool input, or undefined when the shape is unusable. */
export const parse = (input: Record<string, unknown>): readonly Question[] | undefined => {
  const raw = input["questions"]
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const questions: Question[] = []
  for (const entry of raw) {
    const item = record(entry)
    const question = typeof item["question"] === "string" ? item["question"] : undefined
    if (!question) return undefined
    const options = Array.isArray(item["options"])
      ? item["options"].flatMap((option) => {
          const value = record(option)
          const label = typeof value["label"] === "string" ? value["label"] : undefined
          if (!label) return []
          const description = typeof value["description"] === "string" ? value["description"] : undefined
          return [{ label, ...(description ? { description } : {}) }]
        })
      : []
    questions.push({
      question,
      header: typeof item["header"] === "string" && item["header"] ? item["header"] : question,
      multiSelect: item["multiSelect"] === true,
      options,
    })
  }
  return questions
}

const key = (index: number) => `q${index}`

/** The same field shape `core/src/tool/plugin/question.ts` builds. */
export const fields = (questions: readonly Question[]): Form.Field[] =>
  questions.map((question, index) => ({
    key: key(index),
    title: question.header,
    description: question.question,
    type: question.multiSelect ? "multiselect" : "string",
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    // The user may always answer something the model did not offer.
    custom: true,
  })) as Form.Field[]

/** Form answers as the SDK wants them: keyed by question text, joined for multi-select. */
export const answers = (
  questions: readonly Question[],
  answer: Form.Answer,
): Record<string, string> =>
  Object.fromEntries(
    questions.map((question, index) => {
      const value = answer[key(index)]
      if (value === undefined) return [question.question, ""]
      if (Array.isArray(value)) return [question.question, value.join(", ")]
      return [question.question, String(value)]
    }),
  )
