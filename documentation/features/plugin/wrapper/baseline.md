# Wrapper — Baseline

## Invariants

- The wrapper always emits exactly one JSON object to stdout, whether the run succeeded or failed.
- `--mode` and `--cwd` are always required; the wrapper never runs without them.
- `--cwd` is always absolute; a relative path is always exit code 2 and never reaches spawn.
- opencode always requires `--model`; grok and codex never require it.
- The brief is always passed without going through a shell (argv array or stdin, never string interpolation into a shell command).
- Grok's write posture never uses `--permission-mode acceptEdits`, on any mode, ever.
- Grok read mode always denies `mcp__*` and passes `--no-subagents`; a read-mode Grok run can never call MCP tools or spawn subagents.
- Codex always receives `--skip-git-repo-check` on `exec`, regardless of whether `--cwd` is already trusted. Codex's `exec` options (`-C`, `--skip-git-repo-check`, `--json`, `-o`, `-s`, `-m`) always come before the `resume ID` subcommand when `--session` is given, never after.
- Error classification never inspects the model's own answer text (`text`/`parsed.text`); it only inspects stderr, a parsed error message, and whether a structured error event was seen, and only when the run looks failed (non-zero exit, backend-reported failure, or a structured error event). A successful answer that happens to mention "quota" or "login" is never reclassified as a failure.
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
| `--worktree` with non-git `--cwd` | usage error | yes (exit 2) |
| backend binary not found | not_installed | yes (exit 2) |

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
| Binary search path | `PATH` + `~/.grok/bin`, `~/.local/bin`, `~/.opencode/bin`, `/usr/local/bin`, `/opt/homebrew/bin` | not configurable |
| Brief source | trailing argv words after `--` | `--brief-file PATH` |
| Extra backend flags | none | `--extra-args "…"`, shell-word-split and appended after all wrapper-owned flags |

Run directory files (non-dry-run only): `argv.json`, `stdin.txt`, `raw.log`, `text.md`, `envelope.json`, and, for codex, `last.txt` (the file passed to Codex's `-o` flag).

## Access control

Not applicable — this is a local single-user CLI wrapper, no auth boundary of its own. Each backend's own auth (`grok login`, `codex login`, `opencode providers login`) gates access to that backend.

## Known limitations

- The wrapper installs `SIGTERM`/`SIGINT` handlers that kill the active child's process group before the wrapper itself exits. The child is spawned detached specifically so this works. If the wrapper process is sent `SIGKILL` (uncatchable), neither handler runs and the detached child may keep running after the wrapper is gone.

## Tests

`bash plugins/delegate-model/tests/run.sh`, 23 cases, bash 3.2 compatible, backend CLIs mocked via `tests/mocks` on `PATH` (no network or real backend needed). See the wrapper feature doc's Tests section for the full list of case names.
