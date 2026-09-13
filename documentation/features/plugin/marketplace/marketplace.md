# Marketplace

## What it does

The repo root is itself a marketplace containing exactly one plugin, `delegate-model`. Claude Code uses `.claude-plugin/marketplace.json`. Codex CLI uses `.agents/plugins/marketplace.json` plus a portable `plugin.json` (and `.codex-plugin/plugin.json` compatibility overlay) inside `plugins/delegate-model`. Grok TUI has no marketplace command: it loads `plugins/delegate-model/skills/` if that directory is on its skill path.

## User flow

1. Claude Code: `claude plugin marketplace add dvrtech-us/delegate-model`, then `claude plugin install delegate-model@delegate-model`.
2. Codex CLI: `codex plugin marketplace add dvrtech-us/delegate-model` (or a local checkout path), then `codex plugin add delegate-model@delegate-model`. Local add+install was smoked 2026-09-14 (installed, enabled, 1.0.0).
3. Grok TUI: point the TUI at this plugin’s `skills/` directory.
4. The six skills become available. Under Claude they are also `/delegate-model:<name>`.
5. For local development, `claude --plugin-dir ./plugins/delegate-model` and `/reload-plugins`.

## Technical flow

`.claude-plugin/marketplace.json` at the repo root is the Claude Code catalog. `.agents/plugins/marketplace.json` is the Codex catalog; both name the marketplace `delegate-model` and point `source` at `./plugins/delegate-model`. Version is duplicated across `plugins/delegate-model/.claude-plugin/plugin.json`, `plugins/delegate-model/plugin.json`, and `plugins/delegate-model/.codex-plugin/plugin.json` and must stay equal. Codex discovers skills from the plugin’s `skills/` directory.

## Key files

| Path | Role |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code marketplace, repo root |
| `.agents/plugins/marketplace.json` | Codex marketplace, repo root |
| `plugins/delegate-model/.claude-plugin/plugin.json` | Claude Code plugin manifest |
| `plugins/delegate-model/plugin.json` | Portable Agent Plugins manifest (Codex / other hosts) |
| `plugins/delegate-model/.codex-plugin/plugin.json` | Codex compatibility overlay (`skills: "./skills/"`) |
| `plugins/delegate-model/` | Plugin contents (skills, scripts, tests, README, LICENSE) |

## Integration points

Claude Code: `claude plugin marketplace add`, `claude plugin install`, `claude plugin validate`. Codex CLI: `codex plugin marketplace add`, `codex plugin add`. Grok TUI: skill-path load, no marketplace CLI.

## Routes and access control

Not applicable.

## Database

None.
