> redsun can create prompt templates. Ask it to build one for your workflow.

# Prompt Templates

Prompt templates are reusable Markdown files that expand into full prompts when invoked via slash commands. They support argument substitution, shell execution, and custom models.

## Where Templates Live

Templates are discovered from:

| Location | Scope |
|----------|-------|
| `~/.redsun/prompts/` | User — personal templates across all projects |
| `.redsun/prompts/` | Project — project-specific templates |
| `<config dir>/prompts/` | Config — templates from redsun config directories |
| Extension-contributed paths | Extensions can add prompt paths via `resources_discover` |

## Template Format

A `.md` file with optional YAML frontmatter. The template name is the `name` field in frontmatter, or falls back to the filename (without extension).

**Example** — `.redsun/prompts/review.md`:

```markdown
---
name: code-review
description: Review code changes for a specific commit
arguments:
  - name: commit
    description: The commit hash or branch to review
    default: HEAD
---

Review the following code changes:

1. Run: `git diff $1`
2. For each changed file, analyze the diff and identify:
   - Logic errors or bugs
   - Missing error handling
   - Performance issues
   - Security concerns
3. Be thorough and systematic.
```

**Usage**: `/code-review main~3..main` or `/code-review  # uses default HEAD`

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | No | `string` | Command name. Defaults to filename without `.md` |
| `description` | Yes | `string` | Brief description shown in command listings |
| `arguments` | No | `array` | Named argument definitions with `name`, `description`, `default` |

### Argument Substitution

Templates support three substitution patterns:

| Pattern | Example | Description |
|---------|---------|-------------|
| `$1`, `$2`, ... | `$1` | Positional arguments from the command line |
| `$ARGUMENTS` / `$@` | `$ARGUMENTS` | All raw arguments as a single string |
| `{{argName}}` | `{{commit}}` | Named arguments (from frontmatter `arguments` field) |

Positional arguments are split by whitespace (respecting quotes). Named arguments (`{{argName}}`) use frontmatter argument definitions with optional defaults.

## Inline Shell Execution

Text wrapped in `` !`command` `` (backtick-quoted) is executed as a shell command and replaced with the output:

```markdown
---
name: status
description: Show git status and recent commits
---

## Git Status
!`git status --short`

## Recent Commits
!`git log --oneline -5`
```

The shell commands run before the prompt is sent to the agent.

## Using with Custom Models

Templates can target specific models via the `/command` slash command system. The command system uses the `command` tools in the agent configuration. Templates that need specific model capabilities should be used via commands that configure the model.

## Subagent Templates

Set `command.subtask: true` in the frontmatter or use an agent with `mode: "subagent"` to run a template as a subagent task:

```markdown
---
name: plan-review
description: Plan and review in subagent mode
---

Given the current codebase, plan the implementation of $1.
```

When invoked as a subtask, the template content becomes the subagent's prompt, and the subagent works independently before returning results to the main agent.

## Discovery

Prompt templates are loaded on startup and after reload. Extensions can contribute additional template paths via the `resources_discover` event:

```ts
api.on("resources_discover", async (event, ctx) => ({
  promptPaths: ["/path/to/custom/prompts"],
}))
```
