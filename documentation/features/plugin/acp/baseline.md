# ACP client — Baseline

## Invariants

- `acp.js` is a separate launch file from `delegate.js`. There is no `acp` token in `delegate.js` `BACKENDS`.
- `--mode`, `--cwd` (absolute), and `--agent` are always required.
- `--model` is always a usage error on `acp.js`.
- stdin to the ACP agent is not ended until the prompt turn finishes (or the child dies).
- `initialize` never treats a non-empty `authMethods` list as `auth_required`.
- `session/update` chunks received before `session/prompt` is dispatched never become envelope `text`.
- Permission responses are `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
- Read mode prefers `reject_once` then `reject_always`. Write mode prefers `allow_once` then `allow_always`.
- Read mode always prefixes the brief with the read-only instruction block.
- A dirty worktree after `--mode read` (compared to the pre-spawn snapshot) is always `read_mode_violated`.
- Recursion: `DELEGATE_DEPTH` ≥ `DELEGATE_MAX_DEPTH` is `recursion_guard` exit 2 before spawn.
- Child env sets `DELEGATE_DEPTH` to current+1.
- The first `--agent` token is resolved with the same `findBinary` PATHEXT / no-cwd rules as the wrapper. A resolved `.cmd`/`.bat` is spawned via ComSpec, never `shell: true`.
- `--timeout` is measured from spawn, including handshake.
- The agent process group is SIGTERM/SIGKILL-waited before `emit`.
- Unnamed router never selects ACP.

## Flag rules

| Condition | Severity | Blocks? |
|---|---|---|
| missing `--agent` | usage | yes (exit 2) |
| `--model` present | usage | yes (exit 2) |
| `--cwd` relative | usage | yes (exit 2) |
| first `--agent` token not found | not_installed | yes (exit 2) |
| read run dirties git | read_mode_violated | yes (exit 1) |

## Side effects in order (write)

1. Recursion check, cwd/worktree.
2. Spawn ACP agent.
3. initialize, session/new or session/load, session/prompt.
4. Permission auto-answers.
5. Kill agent process group.
6. Capture gitStatus, emit envelope.

## Configuration / defaults

| Setting | Default |
|---|---|
| Handshake cap | 10000 ms (`HANDSHAKE_TIMEOUT_MS`) |
| Timeout | 1800 s (same as wrapper) |
| Client info | `{ name: "delegate-model", title: "Delegate Model", version: "1.0.0" }` |
| protocolVersion | 1 |
| clientCapabilities | `{}` |

## Access control

None of our own. Each agent CLI has its own auth. Permission RPC answers are not a sandbox.
