export const locales = ["en", "zh-CN", "es", "ko", "fr"] as const

export type Locale = (typeof locales)[number]

export const languages: readonly { value: Locale; name: string; english: string }[] = [
  { value: "en", name: "English", english: "English" },
  { value: "zh-CN", name: "简体中文", english: "Simplified Chinese" },
  { value: "es", name: "Español", english: "Spanish" },
  { value: "ko", name: "한국어", english: "Korean" },
  { value: "fr", name: "Français", english: "French" },
]
