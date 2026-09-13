# ACP client as a sibling launch file

- Date: 2026-09-13
- Status: **implemented** (lib extract + acp.js + mock tests + live smoke of `grok agent stdio` and `opencode acp`)
- Feature: generic ACP client (`scripts/acp.js`), not a fifth `delegate.js` backend
- Related: `plugins/delegate-model/scripts/`, `plugins/delegate-model/skills/`
- Prior verdicts (`2026-09-13-claude-backend-and-acp.md`): A convert-existing **never**; D become-an-ACP-agent **never**; B generic client **later**; C permission gate **later**. This document is B, with a thin auto-permission policy as a stepping stone toward C.
- Constraint from user: ACP may be a **different launch file** (`acp.js`), not stuffed into `delegate.js`.

## 1. Problem

`delegate.js` is a one-shot argv+stdout wrapper. ACP is bidirectional JSON-RPC over stdio (`initialize` → `session/new`|`session/load` → `session/prompt`, inbound `session/request_permission`, outbound `session/cancel`). Folding that loop into `runCommand` (write stdin, end stdin, collect stdout, parse) would break the existing backends.

The value of ACP here is **reach**: agents that have no usable ` -p ` contract (Gemini CLI, Copilot `--acp`, Goose, Qwen, Cursor Agent, `grok agent stdio`, `opencode acp`, `claude-agent-acp`). Existing grok/codex/opencode/claude one-shot paths stay as they are.

## 2. Shape

Two launch files, one envelope:

| File | Speaks | Invoked as |
|---|---|---|
| `scripts/delegate.js` | grok / codex / opencode / claude proprietary CLIs | unchanged |
| `scripts/acp.js` | ACP v1 JSON-RPC over stdio | `node "${CLAUDE_PLUGIN_ROOT}/scripts/acp.js" --mode read\|write --cwd /abs --agent "…" -- "brief"` |

Skills: new `skills/acp/SKILL.md`. The `delegate` router **does not** auto-pick ACP (`--agent` is required and agent-specific). Named “ask acp” / “run this through ACP” / “use gemini via acp” only.

`delegate.js` does **not** grow an `acp` backend. Callers that name grok/codex/opencode/claude still go through `delegate.js`.

### Shared code

Do **not** copy worktree/envelope/timeout/recursion into `acp.js`. Small change to `delegate.js`:

```js
if (require.main === module) {
  main().catch(...);
} else {
  module.exports = { /* helpers listed below */ };
}
```

`acp.js` `require`s those helpers. No npm dependencies. No `package.json`. No `@agentclientprotocol/sdk`.

Exported helpers (names as they exist today): `parseCli`-style flag taking, `findBinary`, `extraBinDirs`, `ensureWorktree`, `captureGitStatus`, `isGitRepo`, `childEnv`, `recursionDepth`, `maxRecursionDepth`, `baseEnvelope`, `emit`, `failUsage`, `clipText`, `tailLines`, `mkdir0700`, `nowStamp`, `randHex`, `splitShellWords`, `writeRunFiles`, `killProcessTree` / timeout constants, `TEXT_LIMIT`. `acp.js` does **not** call `runCommand` or `buildFor`/`parseFor`.

If exporting from `delegate.js` is too tangled (module-load running `main`, `emitted` global), extract `scripts/lib.js` instead and have **both** launch files require it. Prefer the extract if the `require.main` patch needs more than ~20 lines. Either way: one implementation of worktree and envelope.

## 3. `acp.js` CLI contract

```
node scripts/acp.js --mode read|write --cwd /abs --agent "cmd [args…]" [options] [-- brief]
```

| Flag | Required | Meaning |
|---|---|---|
| `--mode read\|write` | yes | Same policy as the wrapper. |
| `--cwd /abs` | yes | Absolute. Also sent as `session/new.params.cwd`. Spawn cwd is this path (or the worktree). |
| `--agent "…"` | yes | Shell-word-split launch argv for the ACP agent. First token is resolved via `findBinary`. Missing → exit 2 `usage`. |
| `--model ID` | no | If given, after `session/new`, call `session/set_model` when the agent advertised that method/config; if the agent cannot set a model, exit 1 `usage` with hint to omit `--model`. Do **not** silently ignore. |
| `--session ID` | no | `session/load` when `agentCapabilities.loadSession`; else fail and apply the existing unknown-session retry (once, without `--session`, `sessionRetried: true`). |
| `--worktree [NAME]` | no | Same sibling worktree as `delegate.js`. |
| `--timeout`, `--brief-file`, `--extra-args`, `--dry-run`, `--run-dir` | no | Same meanings. `--extra-args` appended to the **agent** argv after `--agent` words. |

`--dry-run` prints `{ command, cwd, timeoutSecs, mode, backend: "acp", model, worktree, agent }` and spawns nothing. `command` is the resolved agent argv. No `env` key.

`backend` in the envelope is always `"acp"`. `command` is the agent argv (not `["node","acp.js",…]`).

## 4. Session lifecycle (one-shot)

Spawn the agent with piped stdin/stdout/stderr, `detached` as today, `env: childEnv()`, `cwd: effectiveCwd`. **Do not** end stdin until the prompt turn has finished. Stderr tagged into `raw.log`. stdout is NDJSON JSON-RPC only; non-JSON lines go to `raw.log` and are not parsed as answers.

1. Client → `initialize` `{ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "delegate-model", title: "Delegate Model", version } }`. **Do not advertise `fs` or `terminal` in v1.** Agent uses its own tools.
2. If `authMethods` is non-empty and no prior auth, emit `auth_required` and kill the child. We will not drive interactive `authenticate`.
3. `session/new` `{ cwd: effectiveCwd, mcpServers: [] }` → `sessionId`. Or `session/load` when `--session` and capability allows.
4. Optional `session/set_model` / config option if `--model` given.
5. `session/prompt` `{ sessionId, prompt: [{ type: "text", text: brief }] }`.
6. While the prompt request is outstanding:
   - `session/update` with `agent_message_chunk` (and `agent_thought_chunk` ignored for `text`): concatenate `.content.text` in order. Same `messageId` concatenates; a new id starts a new message — **final `text` is the last message's concatenated chunks** (mirrors “final answer only”, not grok's old turn-concat bug).
   - `session/request_permission`: respond immediately per §5. Never wait for a human.
   - Unknown inbound methods: JSON-RPC error `method not found`. Do not hang.
7. `session/prompt` result `stopReason`:
   - `end_turn` → success if `text` non-empty (else existing empty-retry rules)
   - `cancelled` → `timeout` if we cancelled, else `backend_failed`
   - `max_tokens` / `max_turn_requests` / `refusal` → `backend_failed`
8. On wrapper `--timeout`: send `session/cancel` `{ sessionId }`, respond to any in-flight permission with `{ outcome: { outcome: "cancelled" } }`, wait 5s, then SIGTERM/SIGKILL as today.
9. After the prompt result (or failure), kill the agent process group. **No persistent ACP daemon.** Resume is a new process + `session/load`.

`usage` / `costUsd` from `usage_update` when present (`cost.amount` if `currency` is `USD`).

## 5. Permission policy (thin C)

`session/request_permission` is answered by `acp.js`, never by the host TUI.

| Mode | Selection |
|---|---|
| `read` | First option whose `kind` is `reject_once` or `reject_always`. If none, `{ outcome: { outcome: "cancelled" } }`. |
| `write` | First option whose `kind` is `allow_once` or `allow_always`. If none, cancelled. |

This is **not a sandbox**. The agent still executes tools in its own process. It is the ACP analog of `--always-approve` / `dontAsk`. Document that in the skill the same way Grok/Claude write postures are documented. Destructive actions still must not be delegated unattended.

Do **not** implement `fs/read_text_file`, `fs/write_text_file`, or `terminal/*` in this PR. Advertising them would make us the filesystem; refusing them without advertising is the protocol-correct v1. If a given agent cannot function without client fs, that agent is unsupported until a later PR.

## 6. Recursion and safety

`childEnv()` still sets `DELEGATE_DEPTH`. `acp.js` applies the same `recursion_guard` before spawn. An ACP agent that shells out to `delegate.js` or `acp.js` is refused at depth ≥ 1.

`--agent` is attacker-controlled only in the sense the **host** passed it. `acp.js` must spawn via argv array (`splitShellWords` of `--agent` plus `--extra-args`), never `sh -c`.

`--agent` starting with `node` / `npx` is allowed (claude-agent-acp). `findBinary` resolves the first token.

## 7. Tests

New mock: `tests/mocks/acp-agent` — a tiny Node JSON-RPC agent:

- `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }`
- `session/new` → `{ sessionId: "acp-sess-1" }`
- `session/prompt` → emit one `session/update` `agent_message_chunk` `"OK"`, then result `{ stopReason: "end_turn" }`
- `session/request_permission` (optional behavior via `MOCK_BEHAVIOR=ask`): send a permission request with allow_once + reject_once; test that read selects reject and write selects allow
- `session/load` unknown id → JSON-RPC error whose message matches `UNKNOWN_SESSION_RE` so retry fires
- `hang` / `empty` as today

`tests/run.sh` additions (PATH mocks, `DELEGATE_NO_EXTRA_BIN_DIRS=1`): usage missing `--agent`; dry-run argv; parse OK; permission policy read vs write; recursion_guard; timeout sends cancel (mock records a cancel flag).

Existing `delegate.js` tests must stay green unmodified except the `require.main` / extract refactor.

## 8. Docs and router

- New feature dir `documentation/features/plugin/acp/` (primary + baseline + trail) — ACP is a separate feature from `wrapper`.
- `skills/acp/SKILL.md`: when to use (agent has ACP, no first-class backend); `--agent` examples for `gemini --acp`, `opencode acp`, `grok agent stdio`; permission caveat; envelope same as other skills.
- Router: **no** ACP row. Unnamed “delegate this” never picks `acp.js`.
- README / plugin.json: mention ACP as an optional launch path, not a replacement.
- Planning doc `2026-09-13-claude-backend-and-acp.md` is historical; this file supersedes the ACP half.

## 9. Explicitly out of scope

- Converting grok/codex/opencode/claude to ACP (A)
- Exposing delegate-model as an ACP agent for Zed (D)
- `@agentclientprotocol/sdk` runtime dependency
- Persistent `serve` / reconnect
- Client-side `fs` / `terminal` / elicitation
- Interactive permission prompts
- Widening `UNKNOWN_SESSION_RE` / `QUOTA_RE` (still the deferred regex PR)
- Auto-routing unnamed requests to ACP

## 10. PR split

| PR | Contents |
|---|---|
| **1. Extract or export helpers** | `require.main` export **or** `scripts/lib.js`. `delegate.js` tests 55/55 green. No ACP. |
| **2. `acp.js` + mock + tests + skill + feature docs** | The client. |

PR 1 may be the first commits of the same branch if the extract is small.

## 11. Alternatives considered

- **Fifth backend inside `delegate.js`.** Rejected by user (“different launch file”) and by the duplex-vs-one-shot mismatch.
- **`acp.js` fully duplicated.** Rejected; worktree/envelope/recursion must not drift.
- **Advertise fs + implement confined read/write.** Deferred; that’s a real sandbox and a second product.
- **Always-allow permissions even in read mode.** Rejected; read must not approve edits/executes when the agent actually asks.
- **SDK.** Rejected; zero-deps rule still holds.
