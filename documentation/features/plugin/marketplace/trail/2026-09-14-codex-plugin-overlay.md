# Codex plugin overlay

- Date: 2026-09-14
- Feature: marketplace
- Related code: `.agents/plugins/marketplace.json`, `plugins/delegate-model/plugin.json`, `plugins/delegate-model/.codex-plugin/plugin.json`

## Context

Codex CLI has a first-class plugin marketplace. We had documented `codex plugin marketplace add` against the Claude catalog only, and deferred a Codex overlay for lack of a smoke. The user asked to ship the overlay.

## Decisions

- Add portable Agent Plugins `plugin.json` at the plugin root (skills stay in `skills/`).
- Add `.codex-plugin/plugin.json` with `skills: "./skills/"` as the Codex compatibility overlay.
- Add `.agents/plugins/marketplace.json` pointing at `./plugins/delegate-model`.
- Keep `.claude-plugin/` unchanged for Claude Code.
- Version strings in the three plugin manifests must match.

## Smoke (2026-09-14)

```
codex plugin marketplace add /Volumes/dev/repos/personal/delegate-model
codex plugin add delegate-model@delegate-model
```

Result: `delegate-model@delegate-model` installed, enabled, 1.0.0. Cache at `~/.codex/plugins/cache/delegate-model/delegate-model/1.0.0` contained `plugin.json`, `.codex-plugin/`, `.claude-plugin/`, `scripts/`, and skills `acp` `claude` `codex` `delegate` `grok` `opencode`. `codex plugin list` showed marketplace `delegate-model` sourced from this checkout’s `.agents/plugins/marketplace.json`.

## Alternatives Considered

- Rely on Claude `.claude-plugin/marketplace.json` only. Rejected; Codex’s first-class catalog is `.agents/plugins/marketplace.json`.
- Codex-only copy of skills without a plugin.json. Rejected; that skips `CLAUDE_PLUGIN_ROOT`.

## Consequences

- Positive: Codex can install this plugin the same way Claude Code does, with plugin-root env set.
- Negative: version is now copied in three JSON files.
- Negative: GitHub `codex plugin marketplace add dvrtech-us/delegate-model` only sees the overlay after this branch is on the remote.
