# Node Single-File Wrapper

- Date: 2026-09-08
- Feature: wrapper
- Related code: `plugins/delegate-model/scripts/delegate.js`

## Context

Three prior standalone skills (`grok-delegate`, `codex-delegate`, `opencode-delegate`) each documented flags and output-parsing as prose in `~/.claude/skills/`. This let the contract drift: the Grok skill documented `-w` with `-p` even though headless `-p` does not create a worktree from `-w`; the Codex skill had no empty-result retry or JSONL parsing; the opencode skill had no reachability check for local providers, and was observed to hang for minutes when its provider was down.

The marketplace plugin needed a single tested implementation of the shared contract (argv construction, output parsing, retries, timeouts, worktree management) rather than three independently-maintained prose descriptions that Claude re-derives per call.

## Decisions

Implement one wrapper, `plugins/delegate-model/scripts/delegate.js`, in Node with zero npm dependencies. It owns:

- Argument validation and usage errors (exit 2).
- Preflight binary discovery per backend.
- Backend-specific argv construction for read and write modes.
- Spawning via `child_process.spawn` with an argv array (never a shell string) and stdin piping for the brief where supported.
- A timeout with SIGTERM then SIGKILL, since macOS ships neither `timeout` nor `gtimeout` and Node's `child_process` gives this for free.
- Backend-specific output parsing (one JSON object for grok, JSONL for codex, NDJSON for opencode) into one common envelope shape.
- The empty-text and unknown-session retry rules, applied uniformly regardless of backend.
- Optional git worktree creation/reuse for isolated write tasks.

The four skills (`grok`, `codex`, `opencode`, `delegate`) describe *when* and *how to brief* each backend, and read the resulting envelope; they do not construct backend flags themselves.

## Alternatives Considered

- Option A: bash wrapper. Rejected — macOS ships bash 3.2 with no associative arrays and no `timeout`/`gtimeout` binary; a portable timeout would need a subshell/kill dance repeated per invocation.
- Option B: Python wrapper. Rejected — Python is not guaranteed present on Windows, and Node is already a hard dependency of the Codex CLI, so it's present on any machine that can run these backends anyway.
- Option C: generic `--input-command` passthrough with no backend-specific parsing. Rejected as the primary path — it loses `--mode` enforcement (nothing stops a "read" request from carrying write flags) and loses structured parsing (`text`, `sessionId`, `gitStatus`). Kept as `--dry-run` (inspect the argv without running) and `--extra-args` (escape hatch), not as the main contract.

## Consequences

- Positive: flag mistakes (e.g. Grok write with `acceptEdits`) become impossible to make from a skill, because the skill never constructs the flag — the wrapper does, once, and is testable.
- Positive: retries, timeouts, and worktree handling are shared code paths exercised by `tests/run.sh`, not three copies of hand-written bash.
- Negative: the skills can no longer show the "known-good" raw CLI invocation directly; they show the wrapper invocation instead, and a user who wants to bypass the wrapper has no supported way to do so from within this plugin (the raw CLIs remain usable directly outside the plugin, unaffected).
