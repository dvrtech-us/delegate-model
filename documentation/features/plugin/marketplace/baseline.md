# Marketplace — Baseline

## Invariants

- One git repo is one marketplace containing exactly one plugin, in v1.
- Plugin version is `1.0.0` in three manifests that must stay equal: `plugins/delegate-model/.claude-plugin/plugin.json`, `plugins/delegate-model/plugin.json`, and `plugins/delegate-model/.codex-plugin/plugin.json`. Marketplace JSON files never carry their own `version` field.
- The marketplace manifest never sets `metadata.pluginRoot`, since this repo's `source` is `./plugins/delegate-model` and combining a `pluginRoot` with a `./`-prefixed source is not used here.
- The marketplace manifest declares no `userConfig`, MCP server, hooks, `bin/`, or `settings.json` entries.
- License for the plugin is MIT, copyright 2026 DVRTech, present both at the repo root (`LICENSE`) and inside the plugin directory (`plugins/delegate-model/LICENSE`).

## Flag rules

Not applicable — manifests are static JSON, not runtime flags.

## Side effects in order

1. `claude plugin marketplace add dvrtech-us/delegate-model` registers this repo as a marketplace source for Claude Code.
2. `claude plugin install delegate-model@delegate-model` installs the one plugin entry.
3. Skills become available under `/delegate-model:<name>` in Claude Code.
4. Codex: `codex plugin marketplace add` of this repo (or a local checkout) then `codex plugin add delegate-model@delegate-model`. Local add+install was smoked 2026-09-14. Skill copy into `~/.codex/skills` or `.agents/skills` does not set `CLAUDE_PLUGIN_ROOT`.
5. Grok TUI loads skills from the plugin `skills/` directory when that path is configured; it does not use the marketplace CLI.

## Configuration / defaults

| Field | Value |
|---|---|
| Marketplace name | `delegate-model` (Claude and Codex catalogs) |
| Marketplace owner | DVRTech |
| Plugin name | `delegate-model` |
| Plugin source | `./plugins/delegate-model` |
| Claude category | `development` |
| Codex category | `Productivity` |
| License | MIT |

## Access control

Not applicable.
