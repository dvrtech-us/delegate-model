# Marketplace — Baseline

## Invariants

- One git repo is one marketplace containing exactly one plugin, in v1.
- `plugins/delegate-model/.claude-plugin/plugin.json` is the sole authority for the plugin's version; the marketplace entry in `.claude-plugin/marketplace.json` never carries its own `version` field.
- The marketplace manifest never sets `metadata.pluginRoot`, since this repo's `source` is `./plugins/delegate-model` and combining a `pluginRoot` with a `./`-prefixed source is not used here.
- The marketplace manifest declares no `userConfig`, MCP server, hooks, `bin/`, or `settings.json` entries.
- License for the plugin is MIT, copyright 2026 DVRTech, present both at the repo root (`LICENSE`) and inside the plugin directory (`plugins/delegate-model/LICENSE`).

## Flag rules

Not applicable — manifests are static JSON, not runtime flags.

## Side effects in order

1. `claude plugin marketplace add dvrtech-us/delegate-model` registers this repo as a marketplace source.
2. `claude plugin install delegate-model@delegate-model` installs the one plugin entry.
3. Skills become available under `/delegate-model:<name>`.

## Configuration / defaults

| Field | Value |
|---|---|
| Marketplace name | `delegate-model` |
| Marketplace owner | DVRTech |
| Plugin name | `delegate-model` |
| Plugin source | `./plugins/delegate-model` |
| Plugin category | `development` |
| License | MIT |

## Access control

Not applicable.
