---
name: delegate
description: Route a scoped task to whichever local peer agent (Grok, Codex, opencode, or Claude) fits best, through the delegate-model wrapper. Use ONLY when the user asks to "delegate this", "get another model's opinion", "have another agent look at this", or similar, WITHOUT naming a specific backend. If the user names grok, codex, opencode, or claude explicitly, use that backend's own skill instead of this one.
---

# Delegate (router)

This skill only applies when the user has **not** named a backend. If they said "ask grok" or "have codex review this" or "ask claude," go straight to the `grok`, `codex`, `opencode`, or `claude` skill — do not route through here.

## Choosing a backend

| Task shape | Try in this order |
|---|---|
| Implementation (write code, contained change) | grok → opencode → codex → claude |
| Review / critique / plan adversarial check | codex → grok → opencode → claude |
| Local / free / offline pass | opencode |

Claude is last on the first two rows and absent from the third (it is metered). Codex remains the default reviewer; do not skip to Claude because it is "smarter."

When the host is already Claude Code (`CLAUDECODE` or any `CLAUDE_CODE_*` environment variable is set), **skip the claude backend** in this table — you are already that stack. Named "ask claude" still uses the `claude` skill and bypasses this router.

Pick the first backend in the row that matches the task. If that backend fails preflight (not installed, not authenticated, `--dry-run` shows it's misconfigured), fall through to the next one in the row and tell the user you did so.

## How to route

1. Decide the task shape from the request.
2. Pick the backend per the table above.
3. Follow that backend's own skill (`grok`, `codex`, `opencode`, or `claude`) for the actual invocation contract, brief-writing guidance, envelope fields, and troubleshooting.
4. Always tell the user which backend you chose and why, before or alongside the result.

Never invent a sixth invocation path (no raw CLI calls, no MCP server, no flags not documented in the backend skills). This skill only decides *which* of the four to use; it does not define its own wrapper contract.
