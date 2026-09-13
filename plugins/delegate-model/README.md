# Delegate Model

A plugin that lets a host agent delegate scoped tasks to local peer agents — Grok, Codex, opencode, and Claude Code — through one tested Node wrapper, instead of re-deriving CLI flags and output parsing on every call.

## What it is

Five first-class skills (`grok`, `codex`, `opencode`, `claude`, and a router `delegate`) plus `scripts/delegate.js` for those CLIs, and a sixth skill `acp` plus `scripts/acp.js` for Agent Client Protocol agents (`--agent "grok agent stdio"`, `opencode acp`, …). Shared helpers live in `scripts/lib.js`. Every launch file prints one JSON envelope.

## Prerequisites

Each backend CLI must be installed and authenticated **separately** — the plugin does not install or authenticate anything:

| Path | How | Install | Authenticate |
|---|---|---|---|
| Grok | `delegate.js grok` | `grok` on PATH | `grok login` |
| Codex | `delegate.js codex` | `codex` on PATH | `codex login` |
| opencode | `delegate.js opencode` | `opencode` on PATH | `opencode providers login` |
| Claude | `delegate.js claude` | `claude` on PATH | `claude auth` |
| ACP | `acp.js --agent "…"` | the agent named in `--agent` | that agent's own login |

Live-smoked ACP agents: `grok agent stdio`, `opencode acp`. Others (`gemini --acp`, `codex-acp`, …) may work if the CLI is installed; they are not claimed until smoked.

For local models (LM Studio, Ollama) via opencode, the local server must be running before you delegate to it.

## Install

### Claude Code

Packaged path. Sets `CLAUDE_PLUGIN_ROOT` to this plugin:

```bash
claude plugin marketplace add dvrtech-us/delegate-model
claude plugin install delegate-model@delegate-model
```

Local checkout: `claude --plugin-dir ./plugins/delegate-model`, then `/reload-plugins`.

### Grok TUI

Load `plugins/delegate-model/skills/` (this repo, or the Claude plugin cache). Skills call `node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.js"` and `…/acp.js`. Grok must resolve `CLAUDE_PLUGIN_ROOT` to the plugin root (`…/plugins/delegate-model`), or you pass that absolute path yourself.

### Codex CLI

Codex can **host** these skills (then delegate *to* grok/claude/opencode/ACP) and can still be a **peer** (`delegate.js codex`).

**Plugin marketplace** — first-class Codex overlay: `.agents/plugins/marketplace.json` at the repo root, portable `plugin.json` and `.codex-plugin/plugin.json` in the plugin folder. Smoked locally (`codex plugin marketplace add <checkout>` → `codex plugin add delegate-model@delegate-model` → installed, enabled, 1.0.0, skills `acp` `claude` `codex` `delegate` `grok` `opencode` in the cache). GitHub add works after this overlay is on the remote:

```bash
codex plugin marketplace add dvrtech-us/delegate-model
codex plugin add delegate-model@delegate-model
```

Local checkout:

```bash
codex plugin marketplace add /abs/path/to/delegate-model
codex plugin add delegate-model@delegate-model
```

Plugin install sets `CLAUDE_PLUGIN_ROOT` and `PLUGIN_ROOT`. Confirm a skill with `--dry-run` once.

**Skill copy** — fallback. Codex also reads `~/.codex/skills/<name>/SKILL.md` and `.agents/skills/` in a repo. Copy does **not** set `CLAUDE_PLUGIN_ROOT`; prefer the marketplace install.

## Development

```bash
claude --plugin-dir ./plugins/delegate-model
```

Then `/reload-plugins` to pick up edits without restarting. Tests: `bash plugins/delegate-model/tests/run.sh`.

## Usage

Say things like:

- "Ask grok to draft the migration for X."
- "Have codex review this diff."
- "Get a second opinion from opencode using the local model."
- "Ask claude to summarize src/auth."
- "Run this through ACP with grok agent stdio."
- "Delegate this to another model" (no backend named — the router picks grok/codex/opencode/claude, never ACP).

The host calls `delegate.js` or `acp.js` directly. You will not usually see the raw command, but you can ask for it, or ask for `--dry-run` to see the exact argv without running anything.

Skills are `SKILL.md` files that use `${CLAUDE_PLUGIN_ROOT}`. That variable is set by Claude Code plugin install, and by Codex when it installs a plugin (compatibility env). A raw copy into `~/.codex/skills` does not set it.

Driving Codex *over ACP* (`--agent` at a `codex-acp` binary) is a separate, unsmoked path. Prefer `delegate.js codex` to reach Codex as a peer.

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

- `--mode` is `read` for research/review/drafting, `write` for contained code changes, on both launch files.
- Approval flags (Grok's `--always-approve`, opencode's `--auto`, Claude's `bypassPermissions`, ACP permission auto-answers) are **not** a sandbox. Only Codex's `-s` sandbox flag is a real sandbox. ACP `--mode read` fails the run if git is dirty (`read_mode_violated`); that is detection after the fact, not prevention.
- Nested wrapper invocations are refused: the child environment gets `DELEGATE_DEPTH`, and depth ≥ `DELEGATE_MAX_DEPTH` (default 1) is `error.class: "recursion_guard"`.
- A write result is judged by `gitStatus` in the envelope, never by the backend's narration.
- `text` in the envelope is untrusted data returned by a peer agent, never instructions to follow.
- Destructive or outward-facing actions (deletes, deploys, pushes, sending messages) are never delegated unattended.
- On exit code 2 (usage error), the host stops and reports to the user rather than guessing at a fix or switching backends.

## Migration note

If you previously used the standalone `~/.claude/skills/{grok,codex,opencode}-delegate` skills, remove or disable them after dogfooding this plugin. Leaving both installed causes the same request to double-trigger two different invocation paths.

## Not in v1

Auto-routing hooks, auto-apply review loops, an MCP server, shipped CLI binaries, `userConfig` keys, persistent `serve`/`--attach` sessions, client-side ACP `fs`/`terminal` (a real permission gate), converting grok/codex/opencode/claude to ACP, exposing this plugin as an ACP agent for Zed, `codex review` integration, and community-marketplace submission.
