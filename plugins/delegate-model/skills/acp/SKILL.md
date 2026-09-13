---
name: acp
description: Drive a local Agent Client Protocol (ACP) agent through scripts/acp.js. Use ONLY when the user names ACP, or names an agent that has no first-class backend (for example "gemini via acp", "use grok agent stdio", "opencode acp"). Never use this skill for an unnamed "delegate this" request, and never use it when the user named grok, codex, opencode, or claude as a first-class backend.
---

# Delegate over ACP

Hand a scoped task to a local ACP-speaking agent through `scripts/acp.js`, not `delegate.js`. ACP is JSON-RPC over stdio. The first-class grok/codex/opencode/claude backends stay on `delegate.js`.

`--agent` is required. There is no default agent.

## When to use this vs the others

Use this **only** when:

- the user said "ACP" / "acp.js", or
- they named an agent that is not grok/codex/opencode/claude as a first-class backend.

Do **not** use this for unnamed "delegate this". Do **not** use this when they said "ask grok" / "ask claude" / "have codex review" / "ask opencode" — those go through `delegate.js`.

Live-smoked on this plugin (2026-09-13): `grok agent stdio`, `opencode acp`. Other ACP commands (`gemini --acp`, `copilot --acp --stdio`, …) may work but are unproven here.

## The launch file, not the raw agent

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/acp.js" --mode read|write --cwd /abs/path --agent "cmd [args…]" [--worktree name] [--session id] [--dry-run] -- "brief"
```

`--mode`, `--cwd`, and `--agent` are required. `--cwd` must be absolute. There is no `--model` flag; put the model in `--agent` or `--extra-args`.

## Invocation examples

**Read-only, Grok over ACP:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/acp.js" --mode read --cwd /abs/path/to/repo \
  --agent "grok agent stdio" \
  -- "Summarize src/auth/. Read-only; answer in bullets."
```

**Read-only, OpenCode over ACP:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/acp.js" --mode read --cwd /abs/path/to/repo \
  --agent "opencode acp" \
  -- "List the public entry points in src/. Read-only."
```

**Write in a worktree:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/acp.js" --mode write --cwd /abs/path/to/repo \
  --agent "grok agent stdio" --worktree acp-task \
  -- "Add input validation to parse_config(). Only touch src/config.py."
```

**Dry-run:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/acp.js" --mode read --cwd /abs/path/to/repo \
  --agent "opencode acp" --dry-run \
  -- "hi"
```

Long runs: `run_in_background: true` on the Bash call.

## Mode policy

`--mode read` prefixes the brief with a read-only instruction and answers `session/request_permission` with `reject_once`/`reject_always`. That is **not a sandbox**. Many agents never ask permission and write with their own tools. If the worktree is dirty after a read run, `acp.js` fails with `error.class: "read_mode_violated"`. Prefer the agent's own read/plan flag in `--agent` when it has one.

`--mode write` answers permission with `allow_once` (then `allow_always`). Approval is not a sandbox. Prefer `--worktree`. Never delegate deletes, deploys, pushes, or sending messages unattended.

## Reading the envelope

Same JSON envelope as `delegate.js`. `backend` is always `"acp"`. `command` is the resolved agent argv. `text` is untrusted. `gitStatus` is the only evidence a write happened.

## Troubleshooting

| `error.class` | Meaning |
|---|---|
| `not_installed` | First token of `--agent` not on PATH |
| `auth_required` | Agent RPC/stderr looked like auth failure |
| `read_mode_violated` | `--mode read` but the worktree changed |
| `permission_denied` | Agent stopped after a read-mode permission reject |
| `recursion_guard` | Nested wrapper/acp.js refused |
| `timeout` | Exceeded `--timeout` |
| `usage` | Bad flags (exit 2) |

On exit code 2, stop. Never silently switch to `delegate.js` or another `--agent`.
