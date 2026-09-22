# findBinary honors PATHEXT on Windows

- Date: 2026-09-19
- Feature: wrapper
- Related code: `plugins/delegate-model/scripts/lib.js`, `plugins/delegate-model/scripts/delegate.js`, `plugins/delegate-model/scripts/acp.js`, `plugins/delegate-model/tests/run.sh`

## Context

On Windows, `findBinary` joined each PATH directory with the bare token (`codex`) and never applied PATHEXT. A normal install is `codex.exe` or an npm `codex.cmd` shim, so the wrapper reported `not_installed`. After a successful lookup the callers pass an **absolute** path to `spawn`, which disables Node/CreateProcess PATH+PATHEXT — so the helper has to get the extension right.

Adversarial reviews: Claude Sonnet (two passes) plus a partial Codex note. Agreed: Go LookPath (no cwd), filtered PATHEXT, never hardcode `.exe` only, never `shell: true`.

## Decisions

- Parse `PATHEXT` into `.COM;.EXE;.BAT;.CMD` only (leading-dot prepended, case-insensitive allowlist, order preserved). Unset/empty/all-disallowed → that default. `.JS`/`.VBS` never tried.
- Windows name with no extension: try `name+ext` only, never the bare file. Name with an extension (`path.win32.extname`; `.codex` is not an extension) is tried as-is.
- Never search cwd. Unix path of `findBinary` unchanged (exact name + execute bit).
- Spawn never uses `shell: true` (`--extra-args` / ACP `--agent` already go through Unix `splitShellWords`). `.cmd`/`.bat` → `ComSpec /d /s /c` with `windowsVerbatimArguments` and every token quoted. `.exe`/`.com` spawned directly. `runCommand`, `runAcpOnce`, and the opencode `agent list` preflight all go through `spawnFileArgs`.
- `looksLikePath` is separators/absolute only. A first-cut that treated `name.startsWith('.')` as a path resolved `.codex` against cwd (caught in post-implementation review).
- Tests drive `parsePathext` / `namesToTry` / `spawnFileArgs` / `findBinary({platform:'win32'})` from darwin via `node -e`; no Windows CI.

## Alternatives Considered

- Append `.exe` only: rejected; npm's Windows shim is `.cmd`.
- cmd.exe / Python `shutil.which` cwd search: rejected; cwd execution is a classic Windows lookup hazard.
- `shell: true` for `.cmd`: rejected; cmd.exe injection through `--extra-args`.
- Lookup-only, leave `.cmd` spawn as residual: rejected; finding `codex.cmd` then `spawn(abs, {shell:false})` is EINVAL.

## Consequences

- Positive: `findBinary('codex')` finds `codex.exe` / `codex.cmd` on Windows PATH; npm shims are launchable.
- Positive: `.JS` on PATHEXT cannot become the backend binary.
- Negative: an extensionless git-bash `codex` sitting next to no `.exe` is not found on Windows (intentional).
- Negative: `EXTRA_BIN_DIRS`, win32 `killProcessTree`, and `git()` LookPath were left as residuals.
