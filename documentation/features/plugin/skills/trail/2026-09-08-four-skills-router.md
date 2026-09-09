# Four Skills Plus a Router

- Date: 2026-09-08
- Feature: skills
- Related code: `plugins/delegate-model/skills/{grok,codex,opencode,delegate}/SKILL.md`

## Context

Three prior standalone skills each documented their backend's raw CLI directly. The plugin needed to preserve backend-specific guidance (when to use each backend, how to write a brief for a context-free peer agent, backend-specific gotchas) while routing all actual invocation through the shared wrapper (see the `wrapper` trail). It also needed to handle requests that don't name a backend at all ("delegate this," "get another model's opinion") without forcing every phrase-triggered skill to also try to be a router.

## Decisions

Ship four skills instead of one generic `delegate` skill with a backend argument:

- `grok`, `codex`, `opencode`: one per backend, each named to match its folder, each triggering on phrases that name that backend.
- `delegate`: a router skill, scoped by its `description` to trigger only when no backend is named, that picks a backend from a decision table and then defers entirely to that backend's own skill for the invocation contract.

Each backend skill states its known-good invocation pattern for read, write-with-worktree, session follow-up, and dry-run, so Claude does not need to re-derive the wrapper's flag contract per call — it copies a documented example and swaps in the brief and paths.

## Alternatives Considered

- Option C from the design (rejected): one `delegate` skill with a backend argument. Rejected because "ask grok" would depend on the router's classification being correct before Grok-specific guidance (worktree quirks, `acceptEdits` gotcha) is even consulted — a router bug would misroute every named request, not just unnamed ones.
- A single skill with all three backends' guidance inlined. Rejected — 80–120 lines per backend, times three backends, in one file makes it harder for a phrase match to load only the relevant guidance, and makes the router's job (deferring to "that backend's skill") ambiguous.

## Consequences

- Positive: a request naming a backend never depends on router logic at all — it loads that skill directly by phrase match.
- Positive: backend-specific hard-won lessons (Grok's `acceptEdits` trap, opencode's local-provider hang, Codex's trust-directory check) live next to the invocation examples that need them, not in a shared file where they'd have to be qualified per backend.
- Negative: three skills' worth of shared boilerplate (envelope field table, safety language, troubleshooting table shape) is duplicated across `grok`, `codex`, and `opencode` SKILL.md files rather than factored into one place, since each must stand alone as an 80–120 line skill.
