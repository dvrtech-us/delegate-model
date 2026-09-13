# Wrapper — Baseline

## Invariants

- The wrapper always emits exactly one JSON object to stdout, whether the run succeeded or failed.
- `--mode` and `--cwd` are always required; the wrapper never runs without them.
- `--cwd` is always absolute; a relative path is always exit code 2 and never reaches spawn.
- `<backend>` is one of `grok | codex | opencode | claude`.
- If `DELEGATE_DEPTH` is already ≥ `DELEGATE_MAX_DEPTH` (default 1), the wrapper always emits `error.class: "recursion_guard"` and exit 2 before worktree, spawn, or run-directory creation, including on `--dry-run`.
- Every spawned child (and opencode's `agent list` preflight) receives a copy of `process.env` with `DELEGATE_DEPTH` set to the current depth plus one. The wrapper never passes `env: process.env` verbatim.
- When `DELEGATE_NO_EXTRA_BIN_DIRS=1`, `findBinary` searches only `PATH` and never the hardcoded extra directories (`~/.grok/bin`, `~/.local/bin`, `~/.opencode/bin`, `/usr/local/bin`, `/opt/homebrew/bin`).
- Claude's write posture never uses `--permission-mode acceptEdits`, `--bare`, `--max-turns`, or `--dangerously-skip-permissions`. Write is always `bypassPermissions` plus `--max-budget-usd 5`. Read is always `--tools Read,Grep,Glob` (one comma-joined token), `--permission-mode dontAsk`, `--permission-prompts none`, `--safe-mode`, `--disable-slash-commands`, `--output-format stream-json`, `--verbose`.
- Claude argv never contains `--cwd`. Working directory is the spawn `cwd` only.
- Claude's brief is always the positional immediately after `-p`, never stdin (`usesStdinBrief` is true only for codex).
- Claude's `costUsd` reports the wire `total_cost_usd` as-is, including `0`. Grok's `costUsd` 0→null rule is grok-only.
- opencode and claude always require `--model`; grok and codex never require it.
- The brief is always passed without going through a shell (argv array or stdin, never string interpolation into a shell command).
- Grok's write posture never uses `--permission-mode acceptEdits`, on any mode, ever.
- Grok read mode always denies `mcp__*` and passes `--no-subagents`; a read-mode Grok run can never call MCP tools or spawn subagents.
- Codex always receives `--skip-git-repo-check` on `exec`, regardless of whether `--cwd` is already trusted. Codex's `exec` options (`-C`, `--skip-git-repo-check`, `--json`, `-o`, `-s`, `-m`) always come before the `resume ID` subcommand when `--session` is given, never after.
- Error classification never inspects the model's own answer text (`text`/`parsed.text`); it only inspects stderr, a parsed error message, and whether a structured error event was seen, and only when the run looks failed (non-zero exit, backend-reported failure, or a structured error event). A successful answer that happens to mention "quota" or "login" is never reclassified as a failure.
- Grok always runs with `--output-format streaming-messages-json`, never `json`, except when `--json-schema` or `--extra-args` overrides the wrapper's own flag. `grokParse` falls back to the old flat-`json` shape (whole-stdout `JSON.parse`, or a first-`{`/last-`}` brace slice) **only when no recognizable streaming event (an object with a string `type` field) was seen at all** — never merely because there was no terminal `result`/`error` line. An older `grok` CLI on `PATH` is never the reason for this fallback: an incompatible CLI rejects `--output-format streaming-messages-json` at invocation, before producing output, so no parser-level fallback could rescue it; the only two real triggers are `--json-schema` (implies `--output-format json`) and `--extra-args` (appended after, and able to override, the wrapper's own flag).
- `grokParse` resolves the terminal event by **stream order**: whichever of `type: "result"` or `type: "error"` was emitted LAST by the CLI wins — never "result always takes priority over a later error." It sets `failed: true` only when that winning terminal event is a `result` line with `is_error === true` or a `subtype` starting with `error_`, or is itself a `type: "error"` line; this check is evaluated only on the winning terminal line, never on the `system`/`init` line's own `subtype: "init"`, and a missing `subtype` never means failure.
- When recognizable streaming events were seen but none is a terminal `result`/`error` line (a truncated/incomplete stream — e.g. only the `system`/`init` line arrived), `grokParse` always reports `parsed: false` with `errorMessage: 'incomplete stream: no terminal result line'` and preserves `sessionId` from the `system`/`init` line's `session_id`, so a caller can still resume with `--session`. It never sets `failed` in this case (a parse failure, not a structured backend failure), and it never falls through to the flat-`json` fallback.
- Truly empty stdout is always `parsed: false`, `error: 'empty stdout'`, and never sets `failed` — there is no event of any kind to justify treating an empty run as structured failure evidence.
- Grok's `errorMessage` is built only from the result line's `errors[]` array or a `type: "error"` line's `message` field; it never contains the answer text, the whole result object, or the raw NDJSON blob.
- Grok's `costUsd` maps a wire `total_cost_usd` of `0` to `null`, never to `0`, on the theory that grok reports `0`/absent for "cost unreported or incomplete," never for "free."
- Grok's `usage` object, when present, is the Anthropic Messages `message.usage` shape: it always includes a nested `server_tool_use` object and never includes `reasoning_tokens` or `total_tokens` (those existed under the old flat-`json` format and no longer appear under `streaming-messages-json`).
- `UNKNOWN_SESSION_RE` is exactly `unknown session|invalid session|session not found|no rollout found|session get failed|no session id or title matched`, case-insensitive, shared by all four backends; it never matches on bare "session" or "not found" alone. It deliberately excludes `failed to restore session` (matches benign recovery warnings such as `Warning: failed to restore session cache; recovered` on an otherwise-successful run, turning success into a false failure) and `couldn't start session` (matches grok's real auth failure `Couldn't start session: unauthorized (401)`, which must classify as `auth_required` instead). Grok's real missing-session failure is covered by `session get failed` and `no session id or title matched "<id>" for this directory`.
- Unknown-session classification (`isUnknownSession`) is always gated on failure evidence (`failedRun`), exactly like the `QUOTA_RE`/`AUTH_RE` checks; a successful, exit-0 run is never reclassified as `backend_failed` — and never triggers the session-drop retry — merely because stderr contains matching wording.
- Supplying both `--brief-file` and a trailing/positional brief after `--` is always a usage error (exit 2, `failUsage`); the wrapper never silently picks one and discards the other.
- `--dry-run` never spawns a child process and never writes a run directory; it prints exactly `{ command, cwd, timeoutSecs, mode, backend, model, worktree }` and exits 0. No environment variables are ever included in that output.
- A write-mode run always captures `gitStatus` via `git status --short`, both as retry-decision input and as an envelope field.
- Empty-text retries happen at most once per invocation.
- Session retries (unknown/invalid session) happen at most once per invocation, and only when `--session` was supplied.
- A timeout is never retried automatically.
- `--worktree` requires `--cwd` to be a git repository; otherwise it is a usage error (exit 2), never a silent no-op.
- Exit code 2 is reserved for usage/config errors detected before or independent of running the backend (bad flags, not_installed, bad cwd, worktree-on-non-git). Exit code 1 is reserved for a completed-but-failed run.

## Flag rules

| Condition | Severity | Blocks run? |
|---|---|---|
| `--mode` missing | usage error | yes (exit 2) |
| `--cwd` missing or relative | usage error | yes (exit 2) |
| unknown `<backend>` | usage error | yes (exit 2) |
| opencode without `--model` | usage error | yes (exit 2) |
| claude without `--model` | usage error | yes (exit 2) |
| `DELEGATE_DEPTH` ≥ `DELEGATE_MAX_DEPTH` | recursion_guard | yes (exit 2) |
| `--worktree` with non-git `--cwd` | usage error | yes (exit 2) |
| backend binary not found | not_installed | yes (exit 2) |
| both `--brief-file` and a trailing/positional brief supplied | usage error | yes (exit 2) |

## Side effects in order (write mode)

1. Preflight: locate binary, opencode-only reachability probe.
2. If `--worktree`: create or reuse the sibling worktree; effective cwd becomes the worktree path.
3. Spawn backend with write-mode argv.
4. On empty/whitespace text: capture `git status --short` before deciding whether to retry.
5. If dirty: no retry, `error.class: "empty_final_message"`, `gitStatus` populated.
6. If clean: retry once; capture `gitStatus` again after retry regardless of outcome.
7. Emit envelope.

## Configuration / defaults

| Setting | Default | Override |
|---|---|---|
| Timeout | 1800 seconds | `--timeout SECS` or `DELEGATE_TIMEOUT_SECS` env |
| Kill sequence | SIGTERM, wait 5s, SIGKILL | not configurable |
| Run directory | `${CLAUDE_PLUGIN_DATA:-~/.claude/plugins/data/delegate-model}/runs/<timestamp>-<backend>-<rand>`, mode 0700 | `--run-dir PATH` |
| Worktree path | `<cwd>-wt-<NAME>` on branch `delegate/<NAME>` | not configurable |
| Binary search path | `PATH` + `~/.grok/bin`, `~/.local/bin`, `~/.opencode/bin`, `/usr/local/bin`, `/opt/homebrew/bin` | `DELEGATE_NO_EXTRA_BIN_DIRS=1` searches PATH only |
| Recursion depth | `DELEGATE_DEPTH` (default 0) | set on children to current+1 |
| Recursion cap | `DELEGATE_MAX_DEPTH` default 1 | `DELEGATE_MAX_DEPTH` env |
| Claude write budget | `--max-budget-usd 5` | `--extra-args` |
| Brief source | trailing argv words after `--` | `--brief-file PATH` |
| Extra backend flags | none | `--extra-args "…"`, shell-word-split and appended after all wrapper-owned flags |

Run directory files (non-dry-run only): `argv.json`, `stdin.txt`, `raw.log`, `text.md`, `envelope.json`, and, for codex, `last.txt` (the file passed to Codex's `-o` flag).

## Access control

Not applicable — this is a local single-user CLI wrapper, no auth boundary of its own. Each backend's own auth (`grok login`, `codex login`, `opencode providers login`, `claude auth`) gates access to that backend.

## Known limitations

- The wrapper installs `SIGTERM`/`SIGINT` handlers that kill the active child's process group before the wrapper itself exits. The child is spawned detached specifically so this works. If the wrapper process is sent `SIGKILL` (uncatchable), neither handler runs and the detached child may keep running after the wrapper is gone.
- Grok's `raw.log` and in-memory stdout buffer are larger under `streaming-messages-json` than they were under the old buffered `json` format, because every streamed line (including full `tool_result` payloads) is captured, not just the final result. Accepted for now in exchange for observability: the old format emitted nothing until the process exited, so a long-running grok call was indistinguishable from a hang.

## Tests

`bash plugins/delegate-model/tests/run.sh`, 55 cases as of 2026-09-13, bash 3.2 compatible, backend CLIs mocked via `tests/mocks` on `PATH` (no network or real backend needed). See the wrapper feature doc's Tests section for the full list of case names.
