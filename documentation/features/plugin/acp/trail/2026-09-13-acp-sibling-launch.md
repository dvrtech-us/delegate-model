# ACP as a sibling launch file

- Date: 2026-09-13
- Feature: acp
- Related code: `plugins/delegate-model/scripts/{acp.js,lib.js}`, `plugins/delegate-model/skills/acp/SKILL.md`

## Context

Prior plan deferred ACP. User asked to support it, and allowed a different launch file (`acp.js`) so it would not be stuffed into `delegate.js`. Reviews (Claude Opus + Grok 4.5) rejected requiring helpers from `delegate.js` (SIGTERM/orphan, `main()` on require, wrong usage text) and rejected treating permission rejects as a sandbox.

## Decisions

- Extract `scripts/lib.js`; keep `delegate.js` as the one-shot CLI wrapper.
- New `scripts/acp.js` ACP v1 client with `--agent`.
- Duplex JSON-RPC demux; do not end stdin; do not gate on `initialize.authMethods`.
- Text accumulator starts at `session/prompt`.
- Read mode: brief prefix + reject permission kinds + `read_mode_violated` on dirty git.
- No `--model` on `acp.js`.
- Router never auto-picks ACP.
- Live smoke before documenting agents: `grok agent stdio` and `opencode acp` both returned `OK`. Gemini was not installed.

## Alternatives Considered

- Fifth backend inside `delegate.js` / reuse `runCommand`. Rejected: `runCommand` ends stdin.
- `require('./delegate.js')` for helpers. Rejected by both reviews.
- Advertise client `fs` and refuse writes. Deferred; that is a later sandbox.

## Consequences

- Positive: reach to ACP-only agents without breaking four tested CLI backends.
- Negative: `--mode read` is still not a sandbox; `read_mode_violated` is detection after the fact.
- Negative: unsmoked agents (`gemini --acp`, …) are not claimed in the skill.
