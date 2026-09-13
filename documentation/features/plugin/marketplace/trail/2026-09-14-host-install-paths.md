# Host install paths: Claude, Grok, Codex

- Date: 2026-09-14
- Feature: marketplace
- Related code: `README.md`, `plugins/delegate-model/README.md`, `.claude-plugin/marketplace.json`

## Context

The plugin was documented as Claude-only install. Hosts now include Grok TUI (skill path) and Codex CLI (plugin marketplace + skill directories). Codex documents `.claude-plugin/marketplace.json` as a Claude-compatible catalog and sets `CLAUDE_PLUGIN_ROOT` when it installs a plugin.

## Decisions

- Document three host install paths in both READMEs and the marketplace feature docs.
- Claude Code remains the packaged, smoked install.
- Codex `codex plugin marketplace add dvrtech-us/delegate-model` is documented as the official Codex command against this repo’s existing Claude marketplace file, marked unsmoked.
- Codex skill copy (`~/.codex/skills`, `.agents/skills`) is documented with the `CLAUDE_PLUGIN_ROOT` caveat.
- Do not ship a Codex overlay (`plugin.json` / `.agents/plugins/marketplace.json`) in this change.

## Alternatives Considered

- Add a Codex `plugin.json` overlay now. Deferred until someone smokes `codex plugin marketplace add` against this repo.
- Omit Codex host install because it is unsmoked. Rejected; the commands exist and users asked how to install on Codex.

## Consequences

- Positive: Grok and Codex users can find an install path without reading Codex plugin docs from scratch.
- Negative: Codex marketplace install may still fail or skip entries until an overlay is added; the README says so.
