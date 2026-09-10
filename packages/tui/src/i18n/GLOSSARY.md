# TUI terminology

Translations describe the feature at its call site. The English word alone is
insufficient to choose a translation. OpenCode's desktop catalogs at the pin in
`README.md` are the reference for shared concepts; redsun-specific terms are
reviewed in their TUI context.

| Concept                   | 简体中文          | Español                      | 한국어                  | Français                     |
| ------------------------- | ----------------- | ---------------------------- | ----------------------- | ---------------------------- |
| AI token                  | 词元              | token                        | 토큰                    | jeton                        |
| Authentication token      | 令牌              | token de autenticación       | 인증 토큰               | jeton d’authentification     |
| Context                   | 上下文            | contexto                     | 컨텍스트                | contexte                     |
| Model reasoning           | 推理              | razonamiento                 | 추론                    | raisonnement                 |
| Prompt cache              | 提示词缓存        | caché de prompts             | 프롬프트 캐시           | cache des prompts            |
| Context compaction        | 上下文压缩        | compactación del contexto    | 컨텍스트 압축           | compactage du contexte       |
| Agent / subagent          | 智能体 / 子智能体 | agente / subagente           | 에이전트 / 서브에이전트 | agent / sous-agent           |
| Worker model              | 工作智能体模型    | modelo del agente de trabajo | 작업 에이전트 모델      | modèle de l’agent de travail |
| Git worktree              | 工作树            | árbol de trabajo             | 워크트리                | arbre de travail             |
| Companion application     | 配套客户端        | aplicación complementaria    | 컴패니언                | application compagnon        |
| URL origin                | 源地址            | origen                       | 오리진 URL              | origine                      |
| Cryptographic fingerprint | 指纹              | huella criptográfica         | 키 지문                 | empreinte cryptographique    |

## Context-sensitive decisions

- **AI tokens and credentials are different.** Token counts, cache reuse, budgets,
  compaction usage and throughput use 词元, never 令牌. Credentials themselves are
  opaque content and are never passed to translation.
- **Compaction and compact layout are different.** Context summarization uses
  压缩 / compactación / 압축 / compactage. Dense layout uses
  紧凑 / compacto / 간략히 / compact.
- **Model variants are not necessarily reasoning effort.** Keep generic variant
  terminology; do not alias all variants to upstream's “thinking effort”.
- **Git worktrees are not generic workspaces.** Keep 工作树 and the corresponding
  Git-specific terms rather than copying desktop workspace translations.
- **The companion is software, not a person.** Avoid Spanish compañero or Chinese
  伴侣 as standalone labels. Korean fingerprints in device approval are key
  fingerprints, not biometric authentication.
- **Tab in keyboard hints is a keycap.** Preserve `Tab` rather than translating it
  as an application tab or the verb “switch”.
- **Canonical commands remain runnable.** Preserve `redsun remote disable` and
  `tailscale serve status`, as well as flags, URLs, model IDs and placeholders.
- **User text remains untouched.** Goal conditions, task descriptions, messages,
  session names and provider errors are interpolated as values, never looked up
  as translation keys.

## Review and reuse

The Chinese continuation review used DeepSeek with contextual call-site and
upstream comparisons. Spanish, Korean and French were reviewed by the primary
agent. Accepted corrections include worker-model naming, form option toggles,
fork/revert distinctions, generic item labels, keycaps, companion terminology and
command preservation. Stylistic suggestions that conflated distinct features
were not used.

`aliases.ts` records semantic reuse where TUI English differs from desktop
English. English remains the TUI's original string; other locales use the
referenced upstream tuple. The alias targets and runtime translations are tested.
New aliases require checking meaning, not only lexical similarity.

The catalog-coverage test catches missing literal `t()` entries; it does not
establish that every UI string is wired for localization. Remaining untranslated
surfaces include some keyboard-command descriptions, advanced debug/diff views,
and server-originated diagnostics. Missing translations fall back to English.
