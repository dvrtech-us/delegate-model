# Same-Repo Marketplace

- Date: 2026-09-08
- Feature: marketplace
- Related code: `.claude-plugin/marketplace.json`, `plugins/delegate-model/.claude-plugin/plugin.json`

## Context

The design needed to decide how many repos and marketplaces this project spans. Three prior standalone skills lived in separate personal repos with no shared install mechanism. A marketplace plugin needed both an installable path (`marketplace add` + `plugin install`) and a place for a shared wrapper script that all skills use, without duplicating that script per plugin.

## Decisions

One repo (`delegate-model`) is both the marketplace and the sole plugin's source. `.claude-plugin/marketplace.json` at the repo root lists one plugin entry (`./plugins/delegate-model`). `plugins/delegate-model/.claude-plugin/plugin.json` is the plugin's own manifest and the single source of truth for its version, to avoid the marketplace entry and the plugin manifest drifting on version number.

## Alternatives Considered

- Option A: three separate repos, one plugin.json each (no shared marketplace, no shared wrapper). Rejected — three installs, three copies of the wrapper contract to keep in sync.
- Option B: three plugins in one marketplace repo. Rejected — Claude Code marketplace copy semantics forbid a plugin `source` referencing `../` outside its own plugin directory, so three plugins could not share one `scripts/delegate.js` without triplicating it.

## Consequences

- Positive: one `marketplace add` + one `plugin install` gets all three backends and the router at once.
- Positive: the wrapper script is written once and referenced by all four skills via `${CLAUDE_PLUGIN_ROOT}`.
- Negative: the three backends cannot be installed independently of each other — installing `delegate-model` always brings all four skills, even if a user only has one backend CLI installed. Each backend skill's own preflight (`not_installed` error class) handles this at call time rather than at install time.
