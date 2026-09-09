# Wrapper

## What it does

A single Node script that invokes one of three local CLI agents (Grok, Codex, opencode) as a one-shot subprocess, parses its output into a common envelope, and applies shared retry, timeout, and worktree behavior. Claude calls this script instead of the backend CLIs directly, so flag correctness and output parsing are code, not per-call prose.

## User flow

1. Claude decides a task should go to a specific backend (via the `grok`, `codex`, or `opencode` skill) or an unnamed one (via the `delegate` router skill).
2. Claude runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.js" <backend> --mode read|write --cwd /abs/path [options] -- "brief"`.
3. The wrapper resolves the backend argv, optionally creates or reuses a git worktree, spawns the backend CLI with the brief on stdin (or as a single argv element where stdin isn't supported), and enforces a timeout.
4. The wrapper parses backend-specific output into a common JSON envelope and prints exactly one JSON object to stdout.
5. Claude reads the envelope's `ok`, `error.class`, `text`, and `gitStatus` fields and reports back to the user.

## Technical flow

### Entry point

`plugins/delegate-model/scripts/delegate.js`, invoked as `node delegate.js <backend> [flags] -- <brief>`. Zero npm dependencies; uses only Node's `child_process`, `crypto`, `fs`, `http`, `https`, `os`, `path`. JSONL/NDJSON output is parsed by splitting on newlines and calling `JSON.parse` per line, not `readline`.

### Phases

1. **Argument parsing.** `<backend>` must be one of `grok | codex | opencode`. `--mode` and `--cwd` are required; missing either is exit code 2. `--cwd` must be absolute; relative is exit code 2. `opencode` additionally requires `--model`; missing is exit code 2.
2. **Preflight.** Locate the backend binary on `PATH` plus known install directories (`~/.grok/bin`, `~/.local/bin`, `~/.opencode/bin`, `/usr/local/bin`, `/opt/homebrew/bin`). Missing binary is exit code 2 with `error.class: "not_installed"`. For opencode, additionally attempt (best effort, short timeout) to confirm the `plan` agent exists and, when `--model` looks like a local provider (`lmstudio/`, `ollama/`), that its base URL is reachable.
3. **Worktree setup** (if `--worktree NAME` given). Requires `--cwd` to be a git repo, else exit code 2. Creates or reuses a sibling worktree at `<cwd>-wt-<NAME>` on branch `delegate/<NAME>`. The effective working directory for the backend becomes the worktree path.
4. **Argv construction.** Backend-specific flags are assembled per the read/write mode table below. The brief is passed on stdin where the backend supports it (Codex), otherwise as a single argv element (Grok, opencode) — never through a shell.
5. **Spawn and timeout.** `child_process.spawn` with an argv array (no shell interpolation). Default timeout is `--timeout` or `DELEGATE_TIMEOUT_SECS` or 1800 seconds. On timeout: SIGTERM, wait 5s, then SIGKILL.
6. **Output capture.** stdout/stderr interleaved into a run-scoped raw log with stream tags.
7. **Parsing**, backend-specific (see below).
8. **Retry rules**, applied after parsing (see below).
9. **Envelope emission.** One JSON object to stdout, always, whether `ok` is true or false.

### Options

Beyond `--mode`, `--cwd`, `--model`, `--session`, `--worktree [NAME]`, and `--dry-run`, the wrapper also supports:

| Option | Meaning |
|---|---|
| `--timeout SECS` | Overrides the default timeout (see Configuration in the baseline). Must be a positive number. |
| `--brief-file PATH` | Read the brief from a file instead of (or when nothing follows `--`) the trailing argv words. Useful for long briefs. |
| `--extra-args "…"` | Shell-word-split and appended verbatim to the backend argv, after all wrapper-owned flags. Escape hatch for a flag the wrapper doesn't otherwise expose. |
| `--run-dir PATH` | Use this directory for run artifacts instead of the default `${CLAUDE_PLUGIN_DATA}/runs/<timestamp>-<backend>-<rand>` path. |
| `--worktree=NAME` | Equivalent to `--worktree NAME`; the `=NAME` form is accepted alongside the space-separated form. |

### Backend argv (owned by the wrapper, not the caller)

| Backend | Read mode | Write mode | Always |
|---|---|---|---|
| grok | `-p BRIEF --permission-mode dontAsk --deny Write --deny Edit --deny Bash --deny mcp__* --no-subagents` | `-p BRIEF --always-approve --max-turns 120` | `--cwd CWD --output-format json`; `-m MODEL` if given; `-r SESSION` if given |
| codex | `-s read-only` | `-s workspace-write` | `exec -C CWD --skip-git-repo-check --json -o <run-dir>/last.txt -s MODE [-m MODEL] [resume ID] -` (brief on stdin); the `exec` options come before the `resume` subcommand, and `resume ID` only appears when `--session` is given |
| opencode | `--agent plan --auto` plus a read-only instruction prefix on the brief | `--auto` | `run --format json --dir CWD -m MODEL`; `-s SESSION` if given |

The wrapper never emits `--permission-mode acceptEdits` for Grok on any mode — that flag gates shell tools without gating edits, which strands a headless run before it can write. Grok's write posture is always `--always-approve`. Grok read mode also denies `mcp__*` (all MCP tools) and passes `--no-subagents`, so a read-mode Grok run cannot call MCP tools or spawn subagents.

The full grok read argv is `-p BRIEF --permission-mode dontAsk --deny Write --deny Edit --deny Bash --deny mcp__* --no-subagents --cwd CWD --output-format json`, with `-m MODEL` and `-r SESSION` appended when given.

### Parsing per backend

| Backend | Output shape | Extraction |
|---|---|---|
| grok | One JSON object on stdout | `text`, `sessionId`, `stopReason`, `usage`, `total_cost_usd` read directly |
| codex | JSONL events | `sessionId` from `thread.started.thread_id`; final text concatenated from `item.completed` events where `item.type == "agent_message"` (prefer the `-o` output file's content when present); `usage` from `turn.completed.usage`; a `turn.failed` event sets `ok: false` |
| opencode | NDJSON events | Track `text` parts by `messageID`; final text is the parts belonging to the message whose `step_finish` event has `reason == "stop"` (fallback: last message with any text); `sessionID` from any event; an `error` event sets `ok: false` |

Unparseable output in any backend produces `ok: false`, `error.class: "parse_error"`, with the raw output preserved in `rawLog`.

### Retry rules

1. Empty/whitespace `text` after a successful exit:
   - Read mode: retry the identical command once; set `emptyRetried: true`.
   - Write mode: run `git status --short` first. If dirty, do not retry (the run likely did something even though it said nothing). If clean, retry once.
   - Still empty after retry: `ok: false`, `error.class: "empty_final_message"`; `gitStatus` still populated in the envelope.
2. Backend reports an unknown/invalid session and `--session` was supplied: retry once without `--session`; set `sessionRetried: true`.
3. No other automatic retries. A timeout is never retried.

### Classification

`error.class` is decided by inspecting only three channels: raw stderr, a parsed error message (`parsed.errorMessage`, e.g. Codex's `turn.failed`/`error` event message or Grok's `obj.error`), and whether a structured error event was seen at all (`hasStructuredError`/`failed`). The model's own answer text (`parsed.text`) is never inspected for classification. This matters because a successful, on-topic answer can legitimately contain words like "quota" or "rate limit" without that being a failure.

Classification only runs when the run looks failed: the process exited non-zero, the backend reported failure through a structured error event, or a structured error event exists at all. A zero exit with no structured error and no matching text in the error channels is never reclassified as a failure based on content alone.

Within a failed run, in order:

1. `QUOTA_RE` (`\b429\b|rate limit|quota|out of credits`, case-insensitive) matched against stderr + parsed error message → `quota_exceeded`.
2. `UNKNOWN_SESSION_RE` (`unknown session|invalid session|session not found|no rollout found`, case-insensitive) matched, or the parser's own `unknownSession` flag → `backend_failed` with a hint to omit `--session` (this also drives the session-retry rule above).
3. Output that failed to parse at all: `AUTH_RE` (`unauthorized|\b401\b|not authenticated|api key|\blogin\b`) matched → `auth_required`; otherwise `parse_error`.
4. Output that parsed: `AUTH_RE` matched → `auth_required`; otherwise a generic `backend_failed` with the parsed error message or `backend exited <code>`.

A run that isn't classified as failed but returns empty/whitespace text after retries becomes `empty_final_message` (see Retry rules above), which is checked separately from the classifier above.

### Dry run

With `--dry-run`, the wrapper builds the argv exactly as it would for a real run, creates no run directory, spawns nothing, and prints one JSON object with exactly these keys, then exits 0:

```json
{
  "command": ["grok", "-p", "…", "…"],
  "cwd": "/abs/path",
  "timeoutSecs": 1800,
  "mode": "read",
  "backend": "grok",
  "model": "grok-composer-2.5-fast",
  "worktree": null
}
```

No `env` key and no environment variables are included in this output.

### Signal handling

The wrapper installs `SIGTERM` and `SIGINT` handlers on the Node process itself. Both handlers kill the active child's process group (`kill(-pid, 'SIGTERM')` then a forced `SIGKILL` fallback) and exit the wrapper with `143` (SIGTERM) or `130` (SIGINT). The backend child is spawned `detached: true` on non-Windows platforms specifically so the wrapper can signal its whole process group.

Known limitation: if the wrapper process itself receives `SIGKILL` (which cannot be caught), neither handler runs, and the detached child process may keep running after the wrapper is gone. Callers that need a hard timeout should prefer the wrapper's own `--timeout`, which the wrapper enforces internally without needing to be killed from outside.

## Key files

| Path | Role |
|---|---|
| `plugins/delegate-model/scripts/delegate.js` | The wrapper itself |
| `plugins/delegate-model/tests/run.sh` | Test harness (bash 3.2 compatible) |
| `plugins/delegate-model/tests/mocks/{grok,codex,opencode}` | Fake CLI binaries used by tests |
| `plugins/delegate-model/tests/fixtures/*` | Recorded/synthesized backend outputs used to validate parsing |

### Run directory contents

Each non-dry-run invocation writes these files under its run directory (`--run-dir PATH` or the default `${CLAUDE_PLUGIN_DATA:-~/.claude/plugins/data/delegate-model}/runs/<timestamp>-<backend>-<rand>`, mode `0700`):

| File | Contents |
|---|---|
| `argv.json` | The exact argv the wrapper spawned (or re-spawned, on a session retry), as JSON |
| `stdin.txt` | The brief text, exactly as passed to the backend (or as an argv element, for backends that don't take stdin) |
| `raw.log` | stdout and stderr interleaved with `[stdout]`/`[stderr]` tags, one line per spawn attempt including retries |
| `text.md` | The final parsed text (untruncated) |
| `envelope.json` | The full envelope, same JSON printed to stdout |
| `last.txt` | Codex only: the file passed to Codex's `-o` flag, which the wrapper prefers as the source of final text when present |

## Integration points

Called exclusively via `node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate.js" ...` from the four skills in `plugins/delegate-model/skills/`. Not invoked by any hook, MCP server, or other automated trigger in v1.

## Envelope schema

```json
{
  "ok": true,
  "backend": "grok",
  "mode": "write",
  "model": "grok-composer-2.5-fast",
  "cwd": "/abs/repo-wt-task",
  "worktree": { "path": "/abs/repo-wt-task", "branch": "delegate/task", "created": true },
  "command": ["grok", "-p", "…"],
  "exitCode": 0,
  "timedOut": false,
  "durationMs": 48213,
  "text": "…",
  "textTruncated": false,
  "textFile": "/…/runs/20260908-…/text.md",
  "sessionId": "01a0…",
  "usage": { "input_tokens": 6735, "output_tokens": 39 },
  "costUsd": 0.0033,
  "emptyRetried": false,
  "sessionRetried": false,
  "gitStatus": " M src/foo.ts\n",
  "stderrTail": "…",
  "rawLog": "/…/runs/20260908-…/raw.log",
  "error": null
}
```

## Error classes

| `error.class` | Meaning |
|---|---|
| `not_installed` | Backend binary not found on PATH or known install dirs |
| `auth_required` | Backend reported an auth failure (login/401/unauthorized pattern matched) |
| `quota_exceeded` | Backend reported rate limiting or quota exhaustion (429/rate limit pattern matched) |
| `provider_unreachable` | opencode-only: local provider (LM Studio/Ollama) preflight probe failed |
| `timeout` | Process killed after exceeding the timeout |
| `empty_final_message` | Final text empty/whitespace after retry rules were applied |
| `parse_error` | Backend output could not be parsed into the expected shape |
| `backend_failed` | Backend exited non-zero, or emitted an explicit failure event, for another reason |
| `usage` | Bad wrapper invocation: missing required flag, relative `--cwd`, unknown backend, missing `--model` for opencode, `--worktree` on a non-git `--cwd` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Ran, `ok: true` |
| 1 | Ran, `ok: false` (timeout, empty, parse, backend_failed, auth, quota, provider_unreachable) |
| 2 | Usage error: bad flags, not_installed, bad cwd, `--worktree` on a non-git repo |

## Database

None.

## Tests

Run with `bash plugins/delegate-model/tests/run.sh` from the repo root. Bash 3.2 compatible; puts `tests/mocks` first on `PATH` so no real backend CLI or network access is required. Prints one `PASS:`/`FAIL:` line per case plus a final `<n> passed, <n> failed` summary, and exits non-zero if anything failed.

23 cases, in run order:

| # | Test name |
|---|---|
| 1 | usage: missing --mode exits 2 |
| 2 | usage: relative cwd exits 2 |
| 3 | usage: unknown backend exits 2 |
| 4 | usage: opencode without --model exits 2 |
| 5 | not_installed: empty PATH exits 2 |
| 6 | parse: grok fixture text=OK sessionId |
| 7 | parse: codex fixture text=OK sessionId |
| 8 | parse: opencode fixture text=OK sessionId (step_finish stop) |
| 9 | empty retry: read mode retries then OK |
| 10 | empty retry: emptyRetried true when retry also empty |
| 11 | write+dirty: no retry, empty_final_message, gitStatus set |
| 12 | timeout: timedOut, exit 1, envelope, child gone |
| 13 | worktree: creates sibling on delegate/NAME |
| 14 | worktree: reuses existing sibling |
| 15 | worktree: non-git cwd exits 2 |
| 16 | dry-run: prints argv, spawns nothing |
| 17 | dry-run: no env or PATH keys |
| 18 | dry-run: grok read has --no-subagents and --deny mcp__*, no --disable-web-search |
| 19 | dry-run: codex --session exec options before resume |
| 20 | quota: codex out-of-credits → quota_exceeded |
| 21 | quota: answer text mentioning quota/rate limit/login is ok |
| 22 | invariant: ok true iff exit 0 |
| 23 | invariant: ok false iff non-zero exit |
