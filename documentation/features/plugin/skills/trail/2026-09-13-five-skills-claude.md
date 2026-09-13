# Five skills: add claude, keep Codex as default reviewer

- Date: 2026-09-13
- Feature: skills
- Related code: `plugins/delegate-model/skills/{claude,delegate}/SKILL.md`

## Context

Adding a `claude` wrapper backend required a fifth skill so "ask claude" routes by phrase match, plus a router-table update that does not silently replace Codex as the default reviewer (project rule: adversarial review from a non-Anthropic model).

## Decisions

- New `skills/claude/SKILL.md`, folder name = `claude`.
- Router table: implementation grok → opencode → codex → claude; review codex → grok → opencode → claude; local/free remains opencode only.
- When the host is Claude Code (`CLAUDECODE` / `CLAUDE_CODE_*`), unnamed routing skips claude. Named "ask claude" still loads the claude skill.
- Claude `--model` is required in every invocation example.

## Alternatives Considered

- Named-only, never in the router: rejected; last-resort fallback after other preflights fail is useful from Grok TUI.
- Claude as default reviewer: rejected; conflicts with the non-Anthropic review rule.

## Consequences

- Positive: phrase match "ask claude" never depends on the router.
- Negative: five skills now duplicate envelope/troubleshooting boilerplate.
