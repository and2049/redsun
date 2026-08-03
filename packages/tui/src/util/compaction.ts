export function compactionSummary(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .flatMap((part) => (part.type === "text" && part.text?.trim() ? [part.text.trim()] : []))
    .join("\n\n")
    .trim()
}
