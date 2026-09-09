# Wrapper smoke (2026-09-08)

> **Note (2026-09-09):** the grok recording below predates the grok adapter fix (see
> `documentation/features/plugin/wrapper/trail/2026-09-09-grok-streaming-output-format.md`).
> Grok now runs with `--output-format streaming-messages-json` instead of `json`, and its
> `usage` object follows the Anthropic Messages `message.usage` shape (gains nested
> `server_tool_use`, loses `reasoning_tokens`/`total_tokens`). The `command` argv and `usage`
> block in the grok section below are updated to match; everything else in this file (codex,
> opencode) is unaffected and still reflects the original recording. Re-capture this fixture
> against the real CLI the next time a manual smoke pass is done.
>
> **Note (2026-09-09, follow-up):** an adversarial review of that same fix found four further
> `grokParse` defects (unknown-session false positives/gating, a later structured error being
> discarded, a truncated stream masquerading as legacy flat-JSON, and empty stdout fabricating
> failure evidence), fixed on the same branch — see the trail entry's "Follow-up corrections
> (2026-09-09)" section. The clean success run recorded below doesn't exercise any of those
> failure/edge-case paths, so the JSON above is unaffected, but do not treat this file as
> covering them: it has no recording of an unknown-session retry, a truncated stream, or an
> empty-stdout run under `streaming-messages-json`.

Read-mode only, real CLIs on this machine. Recorded from:

```
node scripts/delegate.js grok --mode read --cwd /Volumes/dev/repos/personal/delegate-model -- "Reply with exactly the word OK"
node scripts/delegate.js codex --mode read --cwd /Volumes/dev/repos/personal/delegate-model -- "Reply with exactly the word OK"
node scripts/delegate.js opencode --mode read --cwd /Volumes/dev/repos/personal/delegate-model --model lmstudio/prism-ml/bonsai-27b --timeout 20 -- "Reply with exactly the word OK"
```

## grok — ok

```json
{
  "ok": true,
  "backend": "grok",
  "mode": "read",
  "model": "grok-composer-2.5-fast",
  "cwd": "/Volumes/dev/repos/personal/delegate-model",
  "worktree": null,
  "command": [
    "/Users/davidvanronk/.grok/bin/grok",
    "-p",
    "Reply with exactly the word OK",
    "--permission-mode",
    "dontAsk",
    "--deny",
    "Write",
    "--deny",
    "Edit",
    "--deny",
    "Bash",
    "--cwd",
    "/Volumes/dev/repos/personal/delegate-model",
    "--output-format",
    "streaming-messages-json"
  ],
  "exitCode": 0,
  "timedOut": false,
  "durationMs": 6436,
  "text": "OK",
  "textTruncated": false,
  "textFile": "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022649Z-grok-2719cc/text.md",
  "sessionId": "01a083fd-47ff-7870-af05-c08f686ee6dc",
  "usage": {
    "input_tokens": 6697,
    "cache_read_input_tokens": 11648,
    "cache_creation_input_tokens": 0,
    "output_tokens": 37,
    "server_tool_use": {
      "web_search_requests": 0
    }
  },
  "costUsd": 0.0033048,
  "emptyRetried": false,
  "sessionRetried": false,
  "gitStatus": null,
  "stderrTail": "",
  "rawLog": "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022649Z-grok-2719cc/raw.log",
  "error": null
}
```

## codex — quota_exceeded

```json
{
  "ok": false,
  "backend": "codex",
  "mode": "read",
  "model": null,
  "cwd": "/Volumes/dev/repos/personal/delegate-model",
  "worktree": null,
  "command": [
    "/Users/davidvanronk/.local/bin/codex",
    "exec",
    "-C",
    "/Volumes/dev/repos/personal/delegate-model",
    "--skip-git-repo-check",
    "--json",
    "-o",
    "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022703Z-codex-2c2589/last.txt",
    "-s",
    "read-only",
    "-"
  ],
  "exitCode": 1,
  "timedOut": false,
  "durationMs": 4022,
  "text": "",
  "textTruncated": false,
  "textFile": "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022703Z-codex-2c2589/text.md",
  "sessionId": "01a083fd-8348-7421-abfc-67a363f67be3",
  "usage": null,
  "costUsd": null,
  "emptyRetried": false,
  "sessionRetried": false,
  "gitStatus": null,
  "stderrTail": "",
  "rawLog": "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022703Z-codex-2c2589/raw.log",
  "error": {
    "class": "quota_exceeded",
    "message": "Your workspace is out of credits. Add credits to continue.",
    "hint": "add credits or wait for quota reset"
  }
}
```

## opencode — provider_unreachable (LM Studio down, no hang)

```json
{
  "ok": false,
  "backend": "opencode",
  "mode": "read",
  "model": "lmstudio/prism-ml/bonsai-27b",
  "cwd": "/Volumes/dev/repos/personal/delegate-model",
  "worktree": null,
  "command": [
    "/Users/davidvanronk/.opencode/bin/opencode",
    "run",
    "--format",
    "json",
    "--dir",
    "/Volumes/dev/repos/personal/delegate-model",
    "-m",
    "lmstudio/prism-ml/bonsai-27b",
    "--agent",
    "plan",
    "--auto",
    "[READ-ONLY] Do not edit, write, create, or delete files. Do not run commands that change state. Answer from inspection only.\n\nReply with exactly the word OK"
  ],
  "exitCode": 1,
  "timedOut": false,
  "durationMs": 0,
  "text": "",
  "textTruncated": false,
  "textFile": "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022703Z-opencode-4e853a/text.md",
  "sessionId": null,
  "usage": null,
  "costUsd": null,
  "emptyRetried": false,
  "sessionRetried": false,
  "gitStatus": null,
  "stderrTail": "",
  "rawLog": "/Users/davidvanronk/.claude/plugins/data/delegate-model/runs/20260909T022703Z-opencode-4e853a/raw.log",
  "error": {
    "class": "provider_unreachable",
    "message": "provider lmstudio at http://127.0.0.1:1234/v1 is unreachable",
    "hint": "start the local provider (LM Studio / Ollama) or pick a cloud model"
  }
}
```
