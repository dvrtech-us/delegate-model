# Skills

## What it does

Four Claude Code skills ship in the plugin: `grok`, `codex`, `opencode` (one per backend), and `delegate` (a router used only when the user has not named a backend). Each is model-invoked and also user-invocable directly as `/delegate-model:<name>`.

## User flow

1. User asks Claude to delegate a task, either naming a backend ("ask grok to...") or not ("delegate this to another model").
2. If a backend is named, Claude loads that backend's skill directly.
3. If no backend is named, Claude loads the `delegate` skill, which picks a backend from a decision table based on task shape (implementation, review, or local/free) and then follows that backend's own skill.
4. The chosen skill tells Claude how to write the brief, which wrapper invocation to run, which envelope fields to check, and how to react to failures.
5. Claude reports the outcome and, on write mode, the diff, back to the user.

## Technical flow

Each backend skill's frontmatter `description` carries the trigger phrases and names its backend explicitly, so skill selection by phrase match routes directly to the right backend without going through the router. The router's `description` is scoped to trigger only when no backend is named in the request, to avoid it intercepting requests that already name a backend.

All four skill bodies instruct Claude to invoke the shared wrapper (see the `wrapper` feature) rather than the raw backend CLI, and never to construct backend-specific flags themselves.

## Key files

| Path | Role |
|---|---|
| `plugins/delegate-model/skills/grok/SKILL.md` | Grok backend skill |
| `plugins/delegate-model/skills/codex/SKILL.md` | Codex backend skill |
| `plugins/delegate-model/skills/opencode/SKILL.md` | opencode backend skill |
| `plugins/delegate-model/skills/delegate/SKILL.md` | Router skill, unnamed requests only |

## Integration points

Each skill invokes `plugins/delegate-model/scripts/delegate.js` (the wrapper feature) and nothing else. No hooks, no MCP server.

## Routes and access control

Not applicable — these are Claude Code skills, not HTTP routes. Access to each backend is gated by that backend's own CLI authentication, outside this plugin's control.

## Database

None.
