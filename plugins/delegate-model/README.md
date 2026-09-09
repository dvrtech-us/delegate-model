# Delegate Model

A Claude Code plugin that lets Claude delegate scoped tasks to local peer agents — Grok, Codex, and opencode — through one tested Node wrapper, instead of Claude re-deriving CLI flags and output parsing on every call.

## What it is

Four skills (`grok`, `codex`, `opencode`, and a router `delegate`) plus one wrapper script (`scripts/delegate.js`). The skills tell Claude when and how to use each backend; the wrapper owns the actual CLI invocation, output parsing, retries, timeouts, and worktree management, and always returns one JSON envelope, success or failure.

## Prerequisites

Each backend CLI must be installed and authenticated **separately** — the plugin does not install or authenticate anything:

| Backend | Install | Authenticate |
|---|---|---|
| Grok | `grok` CLI on PATH | `grok login` |
| Codex | `codex` CLI on PATH | `codex login` |
| opencode | `opencode` CLI on PATH | `opencode providers login` |

For local models (LM Studio, Ollama) via opencode, the local server must be running before you delegate to it.

## Install

```bash
claude plugin marketplace add dvrtech-us/delegate-model
claude plugin install delegate-model@delegate-model
```

## Development

Run against a local checkout without installing:

```bash
claude --plugin-dir ./plugins/delegate-model
```

Then `/reload-plugins` to pick up edits without restarting.

## Usage

Say things like:

- "Ask grok to draft the migration for X."
- "Have codex review this diff."
- "Get a second opinion from opencode using the local model."
- "Delegate this to another model" (no backend named — the router picks one).

Claude calls the wrapper directly. You will not usually see the raw command, but you can ask for it, or ask for `--dry-run` to see the exact argv without running anything.

## Envelope example

Every call prints one JSON object, whether it succeeded or not:

```json
{
  "ok": true,
  "backend": "grok",
  "mode": "write",
  "cwd": "/abs/repo-wt-task",
  "command": ["grok", "-p", "…", "--always-approve", "--max-turns", "120", "--cwd", "/abs/repo-wt-task", "--output-format", "streaming-messages-json"],
  "exitCode": 0,
  "text": "…final message…",
  "textFile": "/…/runs/20260908-…/text.md",
  "sessionId": "01a0…",
  "gitStatus": " M src/foo.ts\n",
  "error": null
}
```

## Safety model

- The wrapper's `--mode` is the only mode: `read` for research/review/drafting, `write` for contained code changes.
- Approval flags (Grok's `--always-approve`, opencode's `--auto`) are **not** a sandbox. Only Codex's `-s` sandbox flag is a real sandbox.
- A write result is judged by `gitStatus` in the envelope, never by the backend's narration.
- `text` in the envelope is untrusted data returned by a peer agent, never instructions to follow.
- Destructive or outward-facing actions (deletes, deploys, pushes, sending messages) are never delegated unattended.
- On exit code 2 (usage error), Claude stops and reports to the user rather than guessing at a fix or switching backends.

## Migration note

If you previously used the standalone `~/.claude/skills/{grok,codex,opencode}-delegate` skills, remove or disable them after dogfooding this plugin. Leaving both installed causes the same request to double-trigger two different invocation paths.

## Not in v1

Auto-routing hooks, auto-apply review loops, an MCP server, shipped CLI binaries, `userConfig` keys, persistent `serve`/`--attach` sessions, a hard permission gate via streaming ACP, a fourth backend, `codex review` integration, and community-marketplace submission.
