# Grok Adapter Fix: Streaming Output, Session-Retry Regex, `--brief-file` Conflict

- Date: 2026-09-09
- Feature: wrapper
- Related code: `plugins/delegate-model/scripts/delegate.js` (`grokBuildArgs`, `grokParse`, `UNKNOWN_SESSION_RE`, brief-source resolution)

## Context

Three approved defects were found in the grok adapter after the initial implementation and manual smoke pass (`plugins/delegate-model/tests/SMOKE.md`, recorded 2026-09-08):

1. **Preamble leaking into the answer.** `--output-format json` makes the grok CLI return one `text` field that concatenates the assistant text from *every* turn, with no delimiter between turns. A multi-turn read-mode run (grok reading files, reasoning, then answering) produced a `text` value that started with narration like "I'll read the repo README..." before the actual answer — unfixable downstream, since the wrapper has no way to tell where narration ends and the answer begins once they're concatenated with no separator.
2. **Session retry never fired for grok.** `UNKNOWN_SESSION_RE` (`unknown session|invalid session|session not found|no rollout found`) was written generically and validated against codex/opencode wording, but never against grok's actual failure text. A bad `--session` against the real grok CLI produces messages like `Session "<id>" not found locally, restoring conversation from remote...` or `{"type":"error","message":"Couldn't start session: ..."}` — none of which matched the regex. The run fell through to `parse_error`/"empty stdout" with `sessionRetried: false` instead of the intended unknown-session retry path.
3. **`--brief-file` silently dropped.** When both a trailing/positional brief (after `--`) and `--brief-file` were supplied, the trailing brief always won and the file's content was discarded with no warning (verified via `--dry-run`). This risked silently sending an empty or wrong plan to a peer agent when a caller intended the file to be the brief.

## Decisions

**1. Switch grok to `--output-format streaming-messages-json`, dual-parse in `grokParse`.**

`grokBuildArgs` now emits `--output-format streaming-messages-json` instead of `json`. `grokParse` reuses the existing `parseJsonlLines` helper and resolves the result in this precedence order:

1. The last line with `type: "result"`: `text` from `result` (never `String(undefined)`; `''` when `result` is null/absent); `sessionId` from `session_id` on that line or the `system`/`init` line; `usage` passed through as-is (now the Anthropic Messages `message.usage` shape — nested `server_tool_use`, no `reasoning_tokens`/`total_tokens`); `costUsd` from `total_cost_usd`, mapping a wire value of `0` to `null`; `failed`/`hasStructuredError` from `is_error === true` or a `subtype` starting with `error_`, checked **only** on this line (never the `system` line's `subtype: "init"`); `errorMessage` built only from `errors[]`.
2. Else the last line with `type: "error"` (pre-session failures): `text: ''`, `errorMessage` from `message`, `failed: true`.
3. Else fall back to the old flat-`json` parser (whole-stdout `JSON.parse`, or a first-`{`/last-`}` brace slice), unchanged from before this fix. This fallback is deliberately retained: `--json-schema` implies `--output-format json` regardless of the wrapper's own flag, `--extra-args` is appended after the wrapper's flag and can override it, and an older `grok` CLI on `PATH` might not support the new format at all.
4. No stdout at all: unchanged, `parsed: false`, `'empty stdout'`.

`grokParse` now also returns `failed` (codex and opencode already did). This is required, not cosmetic: the empty-retry gate is `successfulExit && parsed.parsed && isEmptyText(...) && !parsed.failed`. An error result line has no `result` key, so `text` is `''`; without `failed`, the wrapper would retry a real auth/quota/max-turns failure as an empty success instead of classifying it correctly.

`errorMessage` is restricted to `errors[]` text or a `type:error` message — never the answer text, the whole result object, or the raw NDJSON blob. This is a direct consequence of the 2026-09-08 quota false-positive fix (`trail/2026-09-08-error-classification-channels.md`): `errorMessage` feeds `classificationSurfaces` → `QUOTA_RE`/`AUTH_RE`, so letting answer text back into it would reopen that regression.

**2. Widen `UNKNOWN_SESSION_RE` to match grok's real wording.**

The regex grows to also match `failed to restore session`, `couldn't start session`, and `no session id or title matched`, in addition to the existing generic phrasing. It stays deliberately narrow: no bare `session` or `not found`, since it is matched against raw stderr and a generic word would false-positive on unrelated output.

**3. Reject `--brief-file` + trailing brief as a usage error.**

If both a trailing/positional brief and `--brief-file` are supplied, the wrapper now calls `failUsage(...)` (exit 2) with a clear message instead of silently choosing the trailing brief.

## Alternatives Considered

- Option A (defect 1): keep `--output-format json` and try to strip narration heuristically (e.g. take the text after the last paragraph break). Rejected — no reliable delimiter exists between concatenated turns; any heuristic would be a second, fragile parser layered on top of an already-lossy format.
- Option B (defect 1): switch to `streaming-messages-json` with no fallback to the old flat-`json` parser. Rejected — `--json-schema` unconditionally implies `--output-format json`, and `--extra-args` can append a competing `--output-format` after the wrapper's own flag; dropping the fallback would turn either into a silent `parse_error` for a currently-working invocation shape.
- Option C (defect 2): broaden `UNKNOWN_SESSION_RE` with generic terms like `session` or `not found`. Rejected — the regex is matched against raw stderr, which can contain unrelated warnings; a bare `session` or `not found` risks classifying an unrelated stderr line as an unknown-session failure and firing a spurious retry.
- Option D (defect 3): keep the trailing brief as the winner but log a warning to stderr. Rejected — a caller who scripts around the wrapper would not reliably see a warning, and the whole point of `--brief-file` for long briefs is that its content matters; a silent (or easily-missed) downgrade to the wrong brief is worse than a hard failure the caller must resolve.

## Consequences

- Positive: grok's `text` is now always the model's actual final answer, matching the contract already documented for codex/opencode (final text only, not a transcript).
- Positive: a bad `--session` against grok now retries correctly instead of surfacing a confusing `parse_error`, matching the retry behavior already relied on for codex/opencode.
- Positive: `--brief-file` + trailing brief can no longer silently send the wrong (or empty) brief to a peer agent.
- Negative: `raw.log` is larger and stdout is held in memory for the run's duration under `streaming-messages-json`, since every streamed line (including full `tool_result` payloads) is captured rather than a single buffered JSON object. Accepted for now — the prior buffered format emitted nothing until the process exited, making a long grok run indistinguishable from a hang; observability was judged worth the extra size. Not addressed further in this fix.
- Negative: any caller relying on the old grok `usage` shape's `reasoning_tokens`/`total_tokens` fields must now compute those from `server_tool_use`/other Anthropic Messages usage fields, or accept they are gone under `streaming-messages-json` (they remain present only via the flat-`json` fallback path).
- Neutral: the dual-parse fallback means the old flat-`json` shape is still a fully supported input to `grokParse`, not a deprecated path — `--json-schema` and `--extra-args` both route there legitimately.
