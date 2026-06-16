> redsun can create skills. Ask it to build one for your use case.

# Skills

Skills are Markdown files that teach redsun specialized knowledge or workflows. Skills are loaded on-demand by the `skill` tool, making them a lightweight way to extend the agent's capabilities without writing code.

## Where Skills Live

Skills are discovered from these locations:

| Location | Scope |
|----------|-------|
| `~/.redsun/skills/` | User — personal skills across all projects |
| `.redsun/skills/` | Project — project-specific skills |
| `<config dir>/skills/` | Config — skills from redsun config directories |
| Extension-contributed paths | Extensions can add skill paths via `resources_discover` |

## SKILL.md Format

A skill is a directory containing a `SKILL.md` file. The directory name becomes the skill identifier. Supporting files (scripts, templates, images) can live alongside.

**Minimal example** — `.redsun/skills/my-skill/SKILL.md`:

```markdown
---
description: Brief description of what this skill does
allowed-tools: ["read", "write", "grep", "bash"]
---

# Skill Title

Detailed instructions for the agent go here. This is what the agent reads when the skill is loaded.

## Workflow

1. Step one
2. Step two

## Notes

Additional context or constraints.
```

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `description` | Yes | `string` | Brief description shown in the skill list |
| `allowed-tools` | No | `string[]` | Tools the agent is allowed to use while this skill is active. If not specified, all tools are available |
| `disable-model-invocation` | No | `boolean` | If `true`, the agent cannot make LLM calls while the skill is active |

### Skill Content

The Markdown body of the skill is what the agent reads. Write clear, actionable instructions. Use headers, code blocks, and lists as needed.

## Discovery

Skills are listed in the system prompt under `<available_skills>`. The agent sees the skill name and description. To load a skill, the agent calls the `skill` tool with the skill name.

Only skills marked as visible (`display: true` or `display` not set in the frontmatter, which defaults to `false` for `allowed-tools`) are listed in the system prompt.

## Example: Create Extension Skill

A skill that teaches the agent how to create new extensions:

```markdown
---
description: Create a new redsun extension with tools, commands, or event handlers
allowed-tools: ["read", "write", "edit", "bash", "glob", "grep", "reload"]
---

# Create Extension

Use this skill when the user wants to create a new redsun extension.

## Steps

1. Read `docs/extensions.md` in the redsun package directory for the full API reference
2. Create the extension file at `.redsun/extensions/<name>.ts`
3. The file must export a default async function that receives the `api` object
4. Use `api.registerTool()` for LLM-callable tools, `api.registerCommand()` for slash commands, and `api.on()` for event handlers
5. After writing the file, use the `reload` tool to pick up the new extension
```

## Example: Code Review Skill

```markdown
---
description: Perform a thorough code review of changed files
allowed-tools: ["read", "grep", "glob"]
---

# Code Review

Review the changes in the current branch.

## Steps

1. Run `git diff --name-only main` to find changed files
2. For each changed file, read it and identify:
   - Logic errors or bugs
   - Missing error handling
   - Performance issues
   - Security concerns
   - Code style violations
3. Provide a structured review with each finding labeled by severity (critical, high, medium, low)
4. Suggest concrete fixes for each issue
```
