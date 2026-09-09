# Error Classification: Channels Only, Never Answer Text

- Date: 2026-09-08
- Feature: wrapper
- Related code: `plugins/delegate-model/scripts/delegate.js` (`classificationSurfaces`, `classify`)

## Context

During manual smoke testing of the wrapper against the real `grok` CLI, an early version of `classify()` built its match surface from the full combined stdout and stderr, including the backend's own final answer text. A read-mode Grok run was asked a question whose subject matter was quota and rate limits; Grok answered successfully, on topic, with text that happened to contain the words "quota" and "rate limit." Because `QUOTA_RE` was matched against that text, the run was misclassified `error.class: "quota_exceeded"` even though the process exited 0, produced a non-empty answer, and no failure of any kind occurred.

This is a false positive with real cost: a caller trusting `error.class` would tell the user "quota exceeded" for a run that succeeded, and would not surface the (correct, useful) answer.

## Decisions

Narrow classification to three channels only, and never the model's own answer text:

1. Raw stderr from the child process.
2. The backend's own parsed error message (`parsed.errorMessage`, e.g. Codex's `turn.failed`/`error` event message, or Grok's `obj.error`).
3. Whether a structured error event was seen at all (`parsed.hasStructuredError` / `parsed.failed`).

`parsed.text` (the model's final answer) is never passed to `QUOTA_RE`, `AUTH_RE`, or `UNKNOWN_SESSION_RE`.

Additionally, gate classification on the run actually looking failed: a non-zero exit code, `hasStructuredError(parsed)` being true, or both. A zero-exit run with no structured error and no failure-channel match is never reclassified as an error based on content alone, regardless of what the error-pattern regexes would match if applied to the answer.

This is implemented as `classificationSurfaces(stderr, parsed)`, which returns `${stderr}\n${parsed.errorMessage || ''}` and is the only string ever tested against `QUOTA_RE`/`AUTH_RE`/`UNKNOWN_SESSION_RE`, combined with `isFailedRun(exitCode, parsed)` as a precondition in `classify()`.

## Alternatives Considered

- Option A: keep matching the full stdout/stderr blob, but add a code-fence or heuristic to exclude "answer-shaped" text. Rejected — fragile, and every backend's stdout already mixes structured JSON/JSONL with the answer; there's no reliable way to keep matching against the right slice without maintaining a second parser per backend.
- Option B: match answer text too, but only for `quota`/`auth` classes, not `unknown_session`. Rejected — the same false-positive mechanism applies to any pattern matched against untrusted model output; the fix needed to be the source, not the pattern.
- Option C: don't gate on "run looks failed"; keep the channel restriction but classify unconditionally. Rejected — a channel-restricted match could still misfire on stray text a backend puts in stderr as a warning (not a failure), while the process still exits 0; gating on failure-looking signals avoids downgrading a successful run based on incidental stderr noise.

## Consequences

- Positive: a run's own answer, which is untrusted model output not wrapper-controlled data, can never influence `error.class`. This closes the entire class of false positives the quota incident represents, for all three error patterns and all three backends.
- Positive: the fix is testable and covered — `tests/run.sh` includes a fixture (`quota_in_text`) asserting that answer text containing "quota," "rate limit," and "login" still yields `ok: true` with no `error`, alongside the existing `quota` fixture asserting a real Codex quota failure still classifies correctly.
- Negative: if a backend ever reports a real failure exclusively through its answer text, with no matching stderr, no parsed error message, and no structured error event, the wrapper will not classify it (it falls through to `ok: true`, or to `empty_final_message` if the text is also empty). This is judged acceptable: it matches the "text is untrusted data, not truth" principle already documented in the skills, and no backend observed so far reports failures this way.
