# delegate-model

A marketplace repo containing one plugin, `delegate-model`. A host agent (Claude Code, Grok TUI, or anything else that loads these skills) can delegate scoped tasks to local peer agents — Grok, Codex, opencode, and Claude Code — through `scripts/delegate.js`, or to any ACP-speaking CLI through `scripts/acp.js`.

## Install

**Claude Code** (packaged marketplace):

```bash
claude plugin marketplace add dvrtech-us/delegate-model
claude plugin install delegate-model@delegate-model
```

**Grok TUI** — point it at this plugin directory (or the Claude install cache) so it loads `plugins/delegate-model/skills/`. Skills use `${CLAUDE_PLUGIN_ROOT}`; that must resolve to `plugins/delegate-model`.

**Codex CLI** — Codex can be a *host* (it loads these skills and then delegates out) as well as a *peer* (`delegate.js codex`). Host install uses the Codex overlay (`.agents/plugins/marketplace.json` + `plugins/delegate-model/plugin.json`). Local `codex plugin marketplace add <this-checkout>` then `codex plugin add delegate-model@delegate-model` was smoked (installed, enabled, 1.0.0, all six skills in the cache). GitHub add needs this branch on the remote:

```bash
codex plugin marketplace add dvrtech-us/delegate-model
codex plugin add delegate-model@delegate-model
```

From a local clone:

```bash
codex plugin marketplace add /abs/path/to/delegate-model
codex plugin add delegate-model@delegate-model
```

Codex plugin install sets `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT`. Skill copy into `~/.codex/skills/` still works but does **not** set that variable.

See [`plugins/delegate-model/README.md`](plugins/delegate-model/README.md) for prerequisites, usage, the envelope format, and the safety model.

Design background: [`documentation/planning/Plugin/2026-09-08-marketplace-plugin-design.md`](documentation/planning/Plugin/2026-09-08-marketplace-plugin-design.md).
