# ACP client

## What it does

`scripts/acp.js` is a sibling launch file to `delegate.js`. It speaks Agent Client Protocol v1 (JSON-RPC over stdio) to a user-supplied `--agent` command, then emits the same JSON envelope as the one-shot wrapper. It does not replace grok/codex/opencode/claude.

## User flow

1. User names ACP or an ACP-only agent ("use grok agent stdio", "opencode acp").
2. Host loads `skills/acp/SKILL.md` and runs `node scripts/acp.js --mode … --cwd /abs --agent "…" -- "brief"`.
3. `acp.js` spawns the agent, `initialize`s, `session/new` (or `session/load`), `session/prompt`s, answers `session/request_permission` by mode, concatenates `agent_message_chunk` text, kills the agent, prints one envelope.

## Technical flow

Entry: `plugins/delegate-model/scripts/acp.js`. Shared helpers: `plugins/delegate-model/scripts/lib.js`.

1. Parse CLI. `--mode`, `--cwd` (absolute), `--agent` required. `--model` is a usage error.
2. Recursion guard (`DELEGATE_DEPTH`).
3. Worktree (same sibling layout as `delegate.js`).
4. `splitShellWords(--agent)` + `--extra-args`; `findBinary` on first token (PATH, extra dirs, or an explicit path).
5. Spawn with stdin kept open (unlike `runCommand`, which ends stdin).
6. Duplex NDJSON JSON-RPC: outbound requests use a client id space; inbound messages with `method`+`id` are requests (`session/request_permission`); `method` without `id` are notifications (`session/update`).
7. `initialize` with `clientCapabilities: {}` (no fs/terminal). `authMethods` on initialize is **not** treated as logged-out.
8. Handshake RPCs use a 10s cap; `--timeout` starts at spawn.
9. Text accumulator starts at `session/prompt` dispatch so `session/load` history replay cannot become `text`.
10. Read mode: read-only brief prefix; permission kinds `reject_*`; dirty `gitStatus` vs pre-spawn snapshot → `read_mode_violated`.
11. Write mode: permission kinds `allow_once` then `allow_always`.
12. Timeout: `session/cancel`, then SIGTERM / 5s / SIGKILL, then emit.
13. Await child `close` before `emit` so the process group is not orphaned.

Live smoke (2026-09-13): `grok agent stdio` → `text: OK` in 4s; `opencode acp` → `text: OK` in 18s (advertised `authMethods` and still worked). `gemini` was not installed.

## Key files

| Path | Role |
|---|---|
| `plugins/delegate-model/scripts/acp.js` | ACP client |
| `plugins/delegate-model/scripts/lib.js` | Shared envelope/worktree/depth/kill |
| `plugins/delegate-model/skills/acp/SKILL.md` | Skill |
| `plugins/delegate-model/tests/mocks/acp-agent` | Mock ACP agent |

## Integration points

Skills invoke `acp.js` directly. `delegate.js` does not grow an `acp` backend. The unnamed router never selects ACP.

## Envelope

Same schema as the wrapper. `backend` is `"acp"`. Extra dry-run key: `agent` (the `--agent` string). `command` is the resolved agent argv.

## Error classes (ACP-specific)

| class | Meaning |
|---|---|
| `read_mode_violated` | Read run, worktree changed |
| `permission_denied` | Agent stopped after a read-mode reject |
| plus the shared wrapper classes | `not_installed`, `auth_required`, `timeout`, `usage`, `recursion_guard`, `empty_final_message`, `backend_failed`, `quota_exceeded` |

## Tests

`bash plugins/delegate-model/tests/run.sh` includes ACP cases (usage, dry-run, parse, load-history isolation, session retry, permission read/write, dirty-tree read, recursion). Mock only; live smoke is manual.
