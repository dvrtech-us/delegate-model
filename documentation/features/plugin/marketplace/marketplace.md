# Marketplace

## What it does

The repo root is itself a Claude Code marketplace containing exactly one plugin, `delegate-model`. This lets the plugin be installed with `claude plugin marketplace add` and `claude plugin install` directly from this repo, with no separate marketplace repo to maintain.

## User flow

1. User runs `claude plugin marketplace add dvrtech-us/delegate-model`.
2. User runs `claude plugin install delegate-model@delegate-model`.
3. The five skills become available, both model-invoked and as `/delegate-model:<name>`.
4. For local development, a contributor instead runs `claude --plugin-dir ./plugins/delegate-model` and uses `/reload-plugins` to pick up edits.

## Technical flow

`.claude-plugin/marketplace.json` at the repo root declares one marketplace named `delegate-model`, owned by DVRTech, with one plugin entry pointing at `./plugins/delegate-model`. `plugins/delegate-model/.claude-plugin/plugin.json` is the authority for the plugin's own name, version, and description — the marketplace entry does not duplicate the version, to avoid the two drifting apart.

## Key files

| Path | Role |
|---|---|
| `.claude-plugin/marketplace.json` | Marketplace manifest, repo root |
| `plugins/delegate-model/.claude-plugin/plugin.json` | Plugin manifest |
| `plugins/delegate-model/` | The plugin's entire contents (skills, scripts, tests, README, LICENSE) |

## Integration points

None outside Claude Code's own plugin/marketplace install mechanism (`claude plugin marketplace add`, `claude plugin install`, `claude plugin validate`).

## Routes and access control

Not applicable.

## Database

None.
