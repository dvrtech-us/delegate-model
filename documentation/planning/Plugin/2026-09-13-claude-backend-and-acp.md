# Claude backend, and whether to support ACP

- Date: 2026-09-13
- Status: **implemented** (PR 1 plumbing + PR 2 claude backend in `feat/claude-backend`; PR 3 regex widening still deferred)
- Feature: fourth wrapper backend `claude`; ACP deferred
- Related code: `plugins/delegate-model/scripts/delegate.js`, `plugins/delegate-model/skills/`, `plugins/delegate-model/tests/`
- Review: Claude Opus (session `5d99c82a-1a0e-4c95-a3da-ac47c59a54e1`); Grok 4.5 (subagent `01a09bcb-a4a5-7bb3-8114-afbdf4637870`). Codex `quota_exceeded`. Wrapper grok-4.6 read run cancelled (`stop_reason: cancelled` after Bash deny).

This document does not change shipped behavior. Feature docs and baselines stay as they are until the code lands.

## 1. Problem

The wrapper speaks `grok | codex | opencode`. The host is no longer Claude-only: Grok TUI loads these same skills. From a non-Claude host there is no path to the local `claude` CLI (2.1.270 at `~/.local/bin/claude` on this machine).

The original design (`2026-09-08-marketplace-plugin-design.md` §3.9) deferred “fourth backend” and “hard permission gate via streaming ACP.” Both questions are now in front of us.

## 2. Verdicts

| Question | Verdict |
|---|---|
| Add Claude as a delegate? | **Yes**, as a native `claude -p` backend in the existing one-shot wrapper. |
| Support ACP in this work? | **No.** None of the four ACP readings ship now. |

ACP is the editor↔agent JSON-RPC protocol (`initialize`, `session/new`, `session/prompt`, permission round-trips, file/terminal RPCs). This product is a one-shot subprocess with a JSON envelope, timeout, worktree, and `gitStatus`. They are different shapes.

| ACP reading | Verdict | Why |
|---|---|---|
| A. Convert grok/codex/opencode to ACP | **Never** | Throws away three tested argv contracts and Codex’s only real sandbox (`-s`). |
| B. Generic `acp` backend | **Later, maybe never** | Persistent stdio JSON-RPC; user must install per-agent adapters (`@agentclientprotocol/claude-agent-acp`, `codex-acp`, `opencode acp`). For Claude, native `-p` is strictly better. |
| C. ACP permission-request gate | **Later** | Only ACP reading with real product value. Still needs a session lifecycle. Prefer Claude’s `--permission-prompt-tool` before inventing ACP. Stays in Not in v1. |
| D. Expose this wrapper as an ACP agent | **Never** | Inverts the product. Zed already has per-agent adapters. |

Revisit B only if a fifth agent has no usable headless flags.

## 3. Why Claude is not “grok with a different binary”

Verified against `claude --help` on 2.1.270:

- No `--cwd`. Working directory is the spawn cwd (`runCommand` already passes `cwd`).
- No `--max-turns`. Grok’s write backstop cannot be copied. Spend backstop is `--max-budget-usd`.
- `--bare` skips plugins/hooks/CLAUDE.md **and** refuses OAuth/keychain; auth is `ANTHROPIC_API_KEY` only. Wrong “safety” flag for subscription users.
- `--safe-mode` disables CLAUDE.md, skills, plugins, hooks, MCP, custom agents; **auth, model, built-in tools, and permissions work normally.** That is the recursion control we want.
- `--permission-mode` includes `acceptEdits` (the documented Grok strand footgun), `bypassPermissions`, `dontAsk`, `plan`.
- `--permission-prompts` defaults to `host`. The wrapper is not an SDK host. Omit it and permissioned calls wait until the 1800s timeout.
- Piped stdin is supplementary context beside a required positional prompt, not the prompt itself (Codex-style stdin-as-brief would mis-brief).
- Default `claude -p` without `--safe-mode` loads project plugins — including this one — and `CLAUDE.md`. In this repo that file instructs higher models to delegate. That is an instructed recursion loop.

## 4. Locked decisions

These are the defaults after both reviews. Grok 4.5 wins the two disagreements with Opus (brief delivery; host-conditioning lives in the router skill, not the wrapper).

### 4.1 Argv

Read:

```
claude -p BRIEF
  --model MODEL
  --output-format stream-json --verbose
  --permission-mode dontAsk --permission-prompts none
  --tools Read,Grep,Glob
  --safe-mode --disable-slash-commands
  [--resume SESSION]
```

Write:

```
claude -p BRIEF
  --model MODEL
  --output-format stream-json --verbose
  --permission-mode bypassPermissions --permission-prompts none
  --safe-mode --disable-slash-commands
  --max-budget-usd 5
  [--resume SESSION]
```

| Choice | Decision |
|---|---|
| `--model` | **Required**, exit 2 if omitted (same as opencode). Prevents silent host-tier Opus and Opus→Opus “second opinion.” Envelope always records the model. |
| Brief | Positional immediately after `-p`, same as grok. Not stdin. `stdinData` becomes a per-backend capability; claude is false. |
| CWD | `spawn({ cwd: effectiveCwd })` only. Dry-run must assert `--cwd` is **absent** from claude argv. |
| Output | `stream-json` + `--verbose` (observability; grok already left buffered `json`). No `--include-partial-messages`. Confirm in smoke that a terminal `type:"result"` line appears. |
| Recursion (prompt layer) | `--safe-mode` + `--disable-slash-commands` on both modes. **`--bare` is off.** |
| Recursion (process layer) | `DELEGATE_DEPTH` env, all backends. See §4.2. |
| Read tools | Allowlist `--tools Read,Grep,Glob`, not a denylist. `--tools` is variadic; pass one comma-joined token. |
| Write posture | `bypassPermissions`, never `acceptEdits`, never `--dangerously-skip-permissions`. |
| Write backstop | `--max-budget-usd 5` default, overridable later via `--extra-args` or a first-class flag. |
| Session | `--resume SESSION` only. No `--continue`, no `--fork-session`. |
| Worktree | Wrapper `--worktree` only. Never Claude’s own `-w`. Documented default for write. |
| Auth hint | `run \`! claude auth\`` |
| Install hint | Install the Claude Code CLI (https://code.claude.com). |
| Parser | Shared streaming core with grok (result/error/init by stream order). **Do not alias `grokParse`.** Claude’s buffered `json` fallback, if any, reads `result` / `session_id`, not grok’s `text` / `sessionId`. Do not inherit grok’s `costUsd: 0 → null` rule unless Claude’s docs say the same. |
| `--verbose` | On until smoke proves the terminal result line appears without it. |

Rejected flags: `--bare`, `--dangerously-skip-permissions`, `--restricted` (refuses `bypassPermissions`), `--permission-mode plan` (ExitPlanMode + `permission-prompts none` strands), `--max-turns` (absent), `--json-schema`, `--include-partial-messages`, `--forward-subagent-text`, `--no-session-persistence`.

### 4.2 Recursion guard (all backends)

`runCommand` currently passes `env: process.env` verbatim.

- Read `depth = Number(process.env.DELEGATE_DEPTH) || 0`.
- If `depth >= Number(process.env.DELEGATE_MAX_DEPTH || 1)`, emit `error.class: "recursion_guard"` and exit 2 **before spawn**.
- Child env: `{ ...process.env, DELEGATE_DEPTH: String(depth + 1) }`.

Claude Code propagates env into Bash children, so a nested `node delegate.js` sees depth 1 and is refused at the wrapper. Layer 1 (`--safe-mode`) is prompt-level and defeatable; layer 2 is not.

Hint must mention that exporting `DELEGATE_DEPTH` in the user shell self-DoSes every delegation; `DELEGATE_MAX_DEPTH` is the override.

The wrapper does **not** refuse `backend === 'claude'` when `CLAUDECODE` is set. Named “ask claude” from a Claude host (different `--model`, clean session) stays legal. Host skip is a router-skill rule only.

### 4.3 Test escape

`findBinary` always appends `EXTRA_BIN_DIRS`, including `~/.local/bin`. On this machine `claude` lives there. A missing or non-executable `mocks/claude` under restored `HOME` spawns a real billed Claude during tests.

Honor `DELEGATE_NO_EXTRA_BIN_DIRS=1` in `findBinary`. `run.sh` sets it for the empty-PATH test **and** for mock runs. `chmod +x mocks/claude` on the existing chmod line. Amend wrapper baseline “binary search path / not configurable.”

### 4.4 Router

| Task shape | Order |
|---|---|
| Implementation | grok → opencode → codex → **claude last** |
| Review / critique | **codex → grok → opencode → claude last** (Codex remains default) |
| Local / free / offline | opencode only — claude never listed |

When the host is Claude Code (`CLAUDECODE` / `CLAUDE_CODE_*`), the router **skips** claude on unnamed requests. Named `/delegate-model:claude` / “ask claude” bypasses the router, same as today for named backends.

### 4.5 Classification

Do **not** widen `UNKNOWN_SESSION_RE` or `QUOTA_RE` in the same PR as the adapter. Capture Claude’s literal unknown-session and usage-limit strings in smoke, then widen in a follow-up with the phrase-loop tests extended. Those regexes are shared; this repo has already been burned by a quota false positive and by grok session-retry phrasing.

### 4.6 Hints and usage text

`INSTALL_HINT`, `AUTH_HINT`, and `usageText()` become table-driven so a missing `claude` key cannot yield `hint: undefined` (JSON.stringify drops it) or a usage string that still says `grok|codex|opencode`.

## 5. PR split

Three mergeable PRs. Smoke is a gate on PR 2, not a separate product PR.

| PR | Contents | Must not include |
|---|---|---|
| **1. Plumbing** | `DELEGATE_NO_EXTRA_BIN_DIRS`; `DELEGATE_DEPTH` / `DELEGATE_MAX_DEPTH`; `recursion_guard`; `runCommand` env copy; tests; baseline amendments. No claude product. | Claude argv, skills, regex widening |
| **2. Claude backend** | Live smoke first (positional brief, `--verbose`+`stream-json`, `--safe-mode`+OAuth, record unknown-session and limit strings). Then `BACKENDS`, `claudeBuildArgs`, `claudeParse`, `--model` required, hints/usageText, `stdinData` capability, `mocks/claude`, parse + dry-run (no `--cwd`) + not_installed tests, `skills/claude/SKILL.md`, router table, wrapper/skills/README docs, trail, retire “fourth backend” from Not in v1. | Regex widening, any ACP, making Claude the default reviewer |
| **3. Regex widening** | Extend `UNKNOWN_SESSION_RE` / `QUOTA_RE` from **literal** PR 2 smoke strings; extend phrase-loop tests. | Anything else |

PRs 1 and 2 may be stacked; PR 2 must not land without the depth guard. PR 3 stays separate.

## 6. Alternatives considered

- **Copy grok adapter, swap binary.** Rejected. `--max-turns` absent, `--cwd` absent, `--bare` kills auth, `acceptEdits` strands, `grokParse` fallback is the wrong shape, recursion is instructed in this repo.
- **`--bare` for isolation.** Rejected. Subscription users cannot authenticate.
- **ACP as the Claude transport.** Rejected. Extra adapter package, persistent session, worse than native `-p`.
- **Refuse claude in the wrapper when `CLAUDECODE` is set.** Rejected. Named Claude→Claude (other model / clean session) must work. Router-only skip.
- **Stdin-as-brief (Opus).** Rejected. Claude’s stdin is supplementary context. Grok 4.5 + official headless docs win.
- **Optional `--model` inheriting the host default.** Rejected. Silent Opus spend and fake second opinions.
- **Seven sequenced PRs (Opus).** Rejected as ceremony. Three PRs, smoke as a gate on the adapter PR.

## 7. Implementation notes (when we get a go)

Touched files (expected):

- `plugins/delegate-model/scripts/delegate.js` — `BACKENDS`, hints, usage, `findBinary`, `runCommand` env, `buildFor`/`parseFor`/`resolvedModel`, `claudeBuildArgs`/`claudeParse`, `--model` required for claude, `stdinData` capability
- `plugins/delegate-model/tests/run.sh`, `tests/mocks/claude`, `tests/fixtures/claude-*.ndjson`
- `plugins/delegate-model/skills/claude/SKILL.md`, `skills/delegate/SKILL.md`
- `plugins/delegate-model/README.md`, repo `README.md`
- `documentation/features/plugin/wrapper/{wrapper.md,baseline.md,trail/}`
- `documentation/features/plugin/skills/{skills.md,baseline.md,trail/}`
- `documentation/README.md` feature map (no new feature directory until behavior ships)

Live smoke (PR 2, before product code): `claude -p` with `--output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --safe-mode`, plus a stale `--resume` and a recorded usage-limit string if one can be obtained without burning the user. Two probes that require nested `bypassPermissions` (managed-settings refusal, env propagation) need explicit sign-off; a bypass child is unconstrained.

## 8. Success criteria

- `delegate.js claude --mode read --cwd /abs --model sonnet --dry-run` prints argv containing `-p`, `--safe-mode`, `--permission-prompts none`, `--tools Read,Grep,Glob`, and **not** `--cwd` or `--bare` or `--max-turns`.
- Write dry-run contains `bypassPermissions` and `--max-budget-usd`, never `acceptEdits`.
- Missing `--model` is exit 2 / `usage`.
- Empty PATH + `DELEGATE_NO_EXTRA_BIN_DIRS=1` is `not_installed`, never a real `claude`.
- Nested `DELEGATE_DEPTH=1` is `recursion_guard` exit 2 before spawn, all backends.
- Named “ask claude” works from Grok TUI. Unnamed router never picks claude when `CLAUDECODE` is set, and never as the default reviewer.
- No ACP client, adapter, or SDK dependency.
