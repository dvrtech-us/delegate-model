# Claude backend, extra-bin escape, recursion depth guard

- Date: 2026-09-13
- Feature: wrapper
- Related code: `plugins/delegate-model/scripts/delegate.js`, `plugins/delegate-model/tests/{run.sh,mocks/claude,fixtures/claude-ok.ndjson}`

## Context

The wrapper spoke `grok | codex | opencode`. Hosts other than Claude Code (notably Grok TUI) had no path to the local `claude` CLI. A naive grok-clone adapter would have copied `--max-turns` (absent on Claude 2.1.270), `--cwd` (Claude has none), `--bare` (kills OAuth), and `acceptEdits` (strands headless Bash). Nested `claude -p` without a process-level guard would load this plugin. `findBinary` always appended `EXTRA_BIN_DIRS` including `~/.local/bin`, where `claude` lives on this machine, so a missing mock would spawn a billed CLI during tests.

Adversarial reviews: Claude Opus + Grok 4.5. Plan: `documentation/planning/Plugin/2026-09-13-claude-backend-and-acp.md`. ACP was deferred.

## Decisions

- Fourth backend `claude` via native `claude -p`, not ACP.
- `--model` required (exit 2), same as opencode.
- Read: `--permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob --safe-mode --disable-slash-commands --output-format stream-json --verbose`.
- Write: `bypassPermissions`, `--max-budget-usd 5`, never `acceptEdits` / `--bare` / `--max-turns`.
- Brief is the positional after `-p`. `usesStdinBrief` is true only for codex.
- `claudeParse` reuses `grokParse` with `zeroCostMeansNull: false`.
- `DELEGATE_DEPTH` / `DELEGATE_MAX_DEPTH` (default 1): refuse with `recursion_guard` exit 2 before spawn. Child env is a copy with depth+1.
- `DELEGATE_NO_EXTRA_BIN_DIRS=1` makes `findBinary` search PATH only.
- Shared `UNKNOWN_SESSION_RE` / `QUOTA_RE` were **not** widened in this change.

Live smoke (2026-09-13, claude 2.1.270): `stream-json` + `--verbose` emits a terminal `type:result` with `result`/`session_id`/`total_cost_usd`. `--safe-mode` still *listed* the installed `delegate-model` plugin in the init event (`skills` was empty). The env guard is therefore load-bearing.

## Alternatives Considered

- `--bare` for isolation: rejected; subscription auth fails.
- Stdin-as-brief (Opus review): rejected; Claude's stdin is supplementary context.
- Refuse `claude` in the wrapper when `CLAUDECODE` is set: rejected; named Claude→Claude must work. Router-skill skip only.
- ACP transport: rejected; see the planning doc.

## Consequences

- Positive: Grok TUI (and any non-Claude host) can name `claude` as a peer.
- Positive: tests cannot fall through to `~/.local/bin/claude` when the extra-dir escape is set.
- Negative: Claude subscription "usage limit" wording still classifies as `backend_failed` until a follow-up regex PR.
- Negative: `--safe-mode` is not a complete plugin strip on 2.1.270; depth guard is required.
