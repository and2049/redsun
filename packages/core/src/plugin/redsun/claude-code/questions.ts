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
    custom: true,
  })) as Form.Field[]

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
