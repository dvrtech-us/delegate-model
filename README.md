# delegate-model

A Claude Code marketplace repo containing one plugin, `delegate-model`, which lets Claude delegate scoped tasks to local peer agents — Grok, Codex, and opencode — through one tested wrapper instead of re-deriving CLI flags and parsing per call.

## Install

```bash
claude plugin marketplace add dvrtech-us/delegate-model
claude plugin install delegate-model@delegate-model
```

See [`plugins/delegate-model/README.md`](plugins/delegate-model/README.md) for prerequisites, usage, the envelope format, and the safety model.

Design background: [`documentation/planning/Plugin/2026-09-08-marketplace-plugin-design.md`](documentation/planning/Plugin/2026-09-08-marketplace-plugin-design.md).
