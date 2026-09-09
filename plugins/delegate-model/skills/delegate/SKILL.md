---
name: delegate
description: Route a scoped task to whichever local peer agent (Grok, Codex, or opencode) fits best, through the delegate-model wrapper. Use ONLY when the user asks to "delegate this", "get another model's opinion", "have another agent look at this", or similar, WITHOUT naming a specific backend. If the user names grok, codex, or opencode explicitly, use that backend's own skill instead of this one.
---

# Delegate (router)

This skill only applies when the user has **not** named a backend. If they said "ask grok" or "have codex review this," go straight to the `grok`, `codex`, or `opencode` skill — do not route through here.

## Choosing a backend

| Task shape | Try in this order |
|---|---|
| Implementation (write code, contained change) | grok → opencode → codex |
| Review / critique / plan adversarial check | codex → grok → opencode |
| Local / free / offline pass | opencode |

Pick the first backend in the row that matches the task. If that backend fails preflight (not installed, not authenticated, `--dry-run` shows it's misconfigured), fall through to the next one in the row and tell the user you did so.

## How to route

1. Decide the task shape from the request.
2. Pick the backend per the table above.
3. Follow that backend's own skill (`grok`, `codex`, or `opencode`) for the actual invocation contract, brief-writing guidance, envelope fields, and troubleshooting.
4. Always tell the user which backend you chose and why, before or alongside the result.

Never invent a fifth invocation path (no raw CLI calls, no MCP server, no flags not documented in the backend skills). This skill only decides *which* of the three to use; it does not define its own wrapper contract.
