#!/bin/bash
# bash 3.2 compatible. No associative arrays, mapfile, or timeout(1).

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(cd "$TESTS_DIR/.." && pwd)
DELEGATE="$PLUGIN_DIR/scripts/delegate.js"
MOCKS="$TESTS_DIR/mocks"
FIXTURES="$TESTS_DIR/fixtures"
NODE=$(command -v node)
ORIG_PATH="$PATH"
REAL_HOME="$HOME"

if [ -z "$NODE" ]; then
  echo "FAIL: node not found"
  exit 1
fi

chmod +x "$DELEGATE" "$MOCKS/grok" "$MOCKS/codex" "$MOCKS/opencode" "$MOCKS/claude" 2>/dev/null || true

PASS=0
FAIL=0
TMPROOT=$(mktemp -d /tmp/delegate-tests-XXXXXX)

cleanup() {
  rm -rf "$TMPROOT"
  # sibling worktrees live next to repo dirs under TMPROOT, so they go with it
}
trap cleanup EXIT

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s — %s\n' "$1" "$2"
}

json_field() {
  printf '%s' "$1" | "$NODE" -e '
    const fs = require("fs");
    let raw = fs.readFileSync(0, "utf8");
    const start = raw.indexOf("{");
    if (start < 0) { process.stderr.write("no json\n"); process.exit(3); }
    const j = JSON.parse(raw.slice(start));
    const path = process.argv[1].split(".");
    let v = j;
    for (const p of path) {
      if (v == null || typeof v !== "object") { process.exit(4); }
      v = v[p];
    }
    if (v === undefined || v === null) process.stdout.write("");
    else if (typeof v === "object") process.stdout.write(JSON.stringify(v));
    else process.stdout.write(String(v));
  ' "$2"
}

json_has_key() {
  printf '%s' "$1" | "$NODE" -e '
    const fs = require("fs");
    let raw = fs.readFileSync(0, "utf8");
    const start = raw.indexOf("{");
    if (start < 0) process.exit(3);
    const j = JSON.parse(raw.slice(start));
    process.exit(Object.prototype.hasOwnProperty.call(j, process.argv[1]) ? 0 : 1);
  ' "$2"
}

# Exit 0 iff the (possibly dotted) key is PRESENT on the object AND its value
# is strictly JSON null. Distinguishes null from missing/undefined, unlike
# comparing a shelled-out empty string (which collapses all three).
json_is_null_key() {
  printf '%s' "$1" | "$NODE" -e '
    const fs = require("fs");
    let raw = fs.readFileSync(0, "utf8");
    const start = raw.indexOf("{");
    if (start < 0) process.exit(2);
    const j = JSON.parse(raw.slice(start));
    const parts = process.argv[1].split(".");
    let parent = j;
    for (let i = 0; i < parts.length - 1; i++) {
      if (parent == null || typeof parent !== "object") process.exit(2);
      parent = parent[parts[i]];
    }
    const key = parts[parts.length - 1];
    if (parent == null || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, key)) {
      process.exit(1);
    }
    process.exit(parent[key] === null ? 0 : 1);
  ' "$2"
}

run_wrap() {
  # stdout+stderr captured separately; caller sets env (PATH, MOCK_*).
  # Use bash $(<file) so an empty PATH (not_installed test) still works.
  local errfile="$TMPROOT/err.$$"
  local outfile="$TMPROOT/out.$$"
  "$NODE" "$DELEGATE" "$@" >"$outfile" 2>"$errfile"
  EC=$?
  OUT=$(< "$outfile")
  ERR=$(< "$errfile")
}

with_mocks() {
  PATH="$MOCKS:$ORIG_PATH"
  DELEGATE_NO_EXTRA_BIN_DIRS=1
  export PATH DELEGATE_NO_EXTRA_BIN_DIRS
}

# ---------------------------------------------------------------------------
# usage
# ---------------------------------------------------------------------------
with_mocks

run_wrap grok --cwd "$TMPROOT" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then pass "usage: missing --mode exits 2"; else fail "usage: missing --mode exits 2" "error.class=$cls out=$OUT"; fi
else
  fail "usage: missing --mode exits 2" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap grok --mode read --cwd rel/path -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then pass "usage: relative cwd exits 2"; else fail "usage: relative cwd exits 2" "error.class=$cls"; fi
else
  fail "usage: relative cwd exits 2" "exit=$EC out=$OUT"
fi

run_wrap nope --mode read --cwd "$TMPROOT" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then pass "usage: unknown backend exits 2"; else fail "usage: unknown backend exits 2" "error.class=$cls"; fi
else
  fail "usage: unknown backend exits 2" "exit=$EC out=$OUT"
fi

run_wrap opencode --mode read --cwd "$TMPROOT" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then pass "usage: opencode without --model exits 2"; else fail "usage: opencode without --model exits 2" "error.class=$cls"; fi
else
  fail "usage: opencode without --model exits 2" "exit=$EC out=$OUT"
fi

run_wrap claude --mode read --cwd "$TMPROOT" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then pass "usage: claude without --model exits 2"; else fail "usage: claude without --model exits 2" "error.class=$cls out=$OUT"; fi
else
  fail "usage: claude without --model exits 2" "exit=$EC out=$OUT"
fi

# ---------------------------------------------------------------------------
# not_installed
# ---------------------------------------------------------------------------
EMPTY_HOME="$TMPROOT/empty-home"
mkdir -p "$EMPTY_HOME"
HOME="$EMPTY_HOME" PATH= DELEGATE_NO_EXTRA_BIN_DIRS=1 run_wrap grok --mode read --cwd "$TMPROOT" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "not_installed" ]; then pass "not_installed: empty PATH exits 2"; else fail "not_installed: empty PATH exits 2" "error.class=$cls out=$OUT"; fi
else
  fail "not_installed: empty PATH exits 2" "exit=$EC out=$OUT err=$ERR"
fi
HOME="$EMPTY_HOME" PATH= DELEGATE_NO_EXTRA_BIN_DIRS=1 run_wrap claude --mode read --cwd "$TMPROOT" --model sonnet -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  hint=$(json_field "$OUT" "error.hint")
  if [ "$cls" = "not_installed" ] && [ -n "$hint" ]; then
    pass "not_installed: claude empty PATH+no extra dirs exits 2 with hint"
  else
    fail "not_installed: claude empty PATH+no extra dirs exits 2 with hint" "error.class=$cls hint=$hint out=$OUT"
  fi
else
  fail "not_installed: claude empty PATH+no extra dirs exits 2 with hint" "exit=$EC out=$OUT err=$ERR"
fi
with_mocks
HOME="$REAL_HOME"
export HOME

# ---------------------------------------------------------------------------
# parse fixtures
# ---------------------------------------------------------------------------
PARSE_CWD="$TMPROOT/parse-cwd"
mkdir -p "$PARSE_CWD"
PARSE_RUN="$TMPROOT/parse-run"
mkdir -p "$PARSE_RUN"

MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR

run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok" -- "Reply with exactly the word OK"
if [ "$EC" -eq 0 ]; then
  text=$(json_field "$OUT" "text")
  sid=$(json_field "$OUT" "sessionId")
  ok=$(json_field "$OUT" "ok")
  if [ "$text" = "OK" ] && [ "$sid" = "01a083f0-1c50-7e01-af19-c746a5bb6e91" ] && [ "$ok" = "true" ]; then
    pass "parse: grok fixture text=OK sessionId"
  else
    fail "parse: grok fixture text=OK sessionId" "text=$text sid=$sid ok=$ok"
  fi
else
  fail "parse: grok fixture text=OK sessionId" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap codex --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/codex" -- "Reply with exactly the word OK"
if [ "$EC" -eq 0 ]; then
  text=$(json_field "$OUT" "text")
  sid=$(json_field "$OUT" "sessionId")
  ok=$(json_field "$OUT" "ok")
  if [ "$text" = "OK" ] && [ "$sid" = "01a083ab-d4d7-7653-b4b6-e372b98507ce" ] && [ "$ok" = "true" ]; then
    pass "parse: codex fixture text=OK sessionId"
  else
    fail "parse: codex fixture text=OK sessionId" "text=$text sid=$sid ok=$ok"
  fi
else
  fail "parse: codex fixture text=OK sessionId" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap opencode --mode read --cwd "$PARSE_CWD" --model test/fixture --run-dir "$PARSE_RUN/opencode" -- "Reply with exactly the word OK"
if [ "$EC" -eq 0 ]; then
  text=$(json_field "$OUT" "text")
  sid=$(json_field "$OUT" "sessionId")
  ok=$(json_field "$OUT" "ok")
  if [ "$text" = "OK" ] && [ "$sid" = "ses_0123abcd" ] && [ "$ok" = "true" ]; then
    pass "parse: opencode fixture text=OK sessionId (step_finish stop)"
  else
    fail "parse: opencode fixture text=OK sessionId (step_finish stop)" "text=$text sid=$sid ok=$ok"
  fi
else
  fail "parse: opencode fixture text=OK sessionId (step_finish stop)" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap claude --mode read --cwd "$PARSE_CWD" --model haiku --run-dir "$PARSE_RUN/claude" -- "Reply with exactly the word OK"
if [ "$EC" -eq 0 ]; then
  text=$(json_field "$OUT" "text")
  sid=$(json_field "$OUT" "sessionId")
  ok=$(json_field "$OUT" "ok")
  cost=$(json_field "$OUT" "costUsd")
  if [ "$text" = "OK" ] && [ "$sid" = "8eac20a9-5166-4f51-bcfc-b7b19f98f756" ] && [ "$ok" = "true" ] && [ "$cost" = "0.012379" ]; then
    pass "parse: claude fixture text=OK sessionId costUsd"
  else
    fail "parse: claude fixture text=OK sessionId costUsd" "text=$text sid=$sid ok=$ok cost=$cost"
  fi
else
  fail "parse: claude fixture text=OK sessionId costUsd" "exit=$EC out=$OUT err=$ERR"
fi

MOCK_BEHAVIOR=zero_cost
export MOCK_BEHAVIOR
run_wrap claude --mode read --cwd "$PARSE_CWD" --model haiku --run-dir "$PARSE_RUN/claude-zero-cost" -- "hi"
if [ "$EC" -eq 0 ]; then
  cost=$(json_field "$OUT" "costUsd")
  if [ "$cost" = "0" ] && ! json_is_null_key "$OUT" "costUsd"; then
    pass "claude: wire total_cost_usd 0 is preserved as costUsd 0 (not null)"
  else
    fail "claude: wire total_cost_usd 0 is preserved as costUsd 0 (not null)" "costUsd=$cost out=$OUT"
  fi
else
  fail "claude: wire total_cost_usd 0 is preserved as costUsd 0 (not null)" "exit=$EC out=$OUT err=$ERR"
fi
MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR

# ---------------------------------------------------------------------------
# empty retry (read)
# ---------------------------------------------------------------------------
MOCK_STATE_FILE="$TMPROOT/empty-state"
rm -f "$MOCK_STATE_FILE"
export MOCK_STATE_FILE
MOCK_BEHAVIOR=empty_then_ok
export MOCK_BEHAVIOR

run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/empty" -- "hi"
if [ "$EC" -eq 0 ]; then
  retried=$(json_field "$OUT" "emptyRetried")
  text=$(json_field "$OUT" "text")
  ok=$(json_field "$OUT" "ok")
  if [ "$retried" = "true" ] && [ "$text" = "OK" ] && [ "$ok" = "true" ]; then
    pass "empty retry: read mode retries then OK"
  else
    fail "empty retry: read mode retries then OK" "emptyRetried=$retried text=$text ok=$ok out=$OUT"
  fi
else
  fail "empty retry: read mode retries then OK" "exit=$EC out=$OUT err=$ERR"
fi

MOCK_BEHAVIOR=empty
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/empty-empty" -- "hi"
if [ "$EC" -eq 1 ]; then
  retried=$(json_field "$OUT" "emptyRetried")
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  if [ "$retried" = "true" ] && [ "$ok" = "false" ] && [ "$cls" = "empty_final_message" ]; then
    pass "empty retry: emptyRetried true when retry also empty"
  else
    fail "empty retry: emptyRetried true when retry also empty" "emptyRetried=$retried ok=$ok class=$cls out=$OUT"
  fi
else
  fail "empty retry: emptyRetried true when retry also empty" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# write + dirty: no retry
# ---------------------------------------------------------------------------
REPO="$TMPROOT/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name test
printf 'x\n' > "$REPO/README"
git -C "$REPO" add README
git -C "$REPO" commit -q -m init

MOCK_BEHAVIOR=touch_file
export MOCK_BEHAVIOR
run_wrap grok --mode write --cwd "$REPO" --run-dir "$PARSE_RUN/write-dirty" -- "touch something"
if [ "$EC" -eq 1 ]; then
  cls=$(json_field "$OUT" "error.class")
  retried=$(json_field "$OUT" "emptyRetried")
  gs=$(json_field "$OUT" "gitStatus")
  ok=$(json_field "$OUT" "ok")
  if [ "$cls" = "empty_final_message" ] && [ "$retried" = "false" ] && [ -n "$gs" ] && [ "$ok" = "false" ]; then
    pass "write+dirty: no retry, empty_final_message, gitStatus set"
  else
    fail "write+dirty: no retry, empty_final_message, gitStatus set" "class=$cls retried=$retried gitStatus='$gs' ok=$ok"
  fi
else
  fail "write+dirty: no retry, empty_final_message, gitStatus set" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# timeout
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=hang
export MOCK_BEHAVIOR
MOCK_PID_FILE="$TMPROOT/hang.pid"
export MOCK_PID_FILE
rm -f "$MOCK_PID_FILE"
run_wrap grok --mode read --cwd "$PARSE_CWD" --timeout 1 --run-dir "$PARSE_RUN/timeout" -- "hang please"
if [ "$EC" -eq 1 ]; then
  timed=$(json_field "$OUT" "timedOut")
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  gone=1
  if [ -f "$MOCK_PID_FILE" ]; then
    pid=$(cat "$MOCK_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then gone=0; fi
  fi
  if [ "$timed" = "true" ] && [ "$ok" = "false" ] && [ "$cls" = "timeout" ] && [ "$gone" -eq 1 ] && [ -n "$OUT" ]; then
    pass "timeout: timedOut, exit 1, envelope, child gone"
  else
    fail "timeout: timedOut, exit 1, envelope, child gone" "timedOut=$timed ok=$ok class=$cls gone=$gone out=$OUT"
  fi
else
  fail "timeout: timedOut, exit 1, envelope, child gone" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# worktree create + reuse + non-git
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR
WT_REPO="$TMPROOT/wtrepo"
mkdir -p "$WT_REPO"
git -C "$WT_REPO" init -q
git -C "$WT_REPO" config user.email test@example.com
git -C "$WT_REPO" config user.name test
printf 'x\n' > "$WT_REPO/README"
git -C "$WT_REPO" add README
git -C "$WT_REPO" commit -q -m init

run_wrap grok --mode read --cwd "$WT_REPO" --worktree task --run-dir "$PARSE_RUN/wt1" -- "hi"
if [ "$EC" -eq 0 ]; then
  created=$(json_field "$OUT" "worktree.created")
  wpath=$(json_field "$OUT" "worktree.path")
  branch=$(json_field "$OUT" "worktree.branch")
  if [ "$created" = "true" ] && [ -d "$WT_REPO-wt-task" ] && [ "$wpath" = "$WT_REPO-wt-task" ] && [ "$branch" = "delegate/task" ]; then
    pass "worktree: creates sibling on delegate/NAME"
  else
    fail "worktree: creates sibling on delegate/NAME" "created=$created path=$wpath branch=$branch exists=$(ls -d "$WT_REPO-wt-task" 2>/dev/null)"
  fi
else
  fail "worktree: creates sibling on delegate/NAME" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap grok --mode read --cwd "$WT_REPO" --worktree task --run-dir "$PARSE_RUN/wt2" -- "hi"
if [ "$EC" -eq 0 ]; then
  created=$(json_field "$OUT" "worktree.created")
  if [ "$created" = "false" ]; then
    pass "worktree: reuses existing sibling"
  else
    fail "worktree: reuses existing sibling" "created=$created out=$OUT"
  fi
else
  fail "worktree: reuses existing sibling" "exit=$EC out=$OUT err=$ERR"
fi

NONGIT="$TMPROOT/nongit"
mkdir -p "$NONGIT"
run_wrap grok --mode read --cwd "$NONGIT" --worktree x --run-dir "$PARSE_RUN/wt3" -- "hi"
if [ "$EC" -eq 2 ]; then
  pass "worktree: non-git cwd exits 2"
else
  fail "worktree: non-git cwd exits 2" "exit=$EC out=$OUT"
fi

# ---------------------------------------------------------------------------
# dry-run: prints argv, spawns nothing
# ---------------------------------------------------------------------------
MARKER="$TMPROOT/spawned"
rm -f "$MARKER"
MOCK_SPAWN_MARKER="$MARKER"
export MOCK_SPAWN_MARKER
MOCK_BEHAVIOR=touch_file
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --dry-run -- "hi"
if [ "$EC" -eq 0 ]; then
  cmd0=$(json_field "$OUT" "command")
  if [ -f "$MARKER" ]; then
    fail "dry-run: prints argv, spawns nothing" "mock was spawned"
  elif ! printf '%s' "$OUT" | grep -q '"command"'; then
    fail "dry-run: prints argv, spawns nothing" "no command in out=$OUT"
  elif json_has_key "$OUT" "env"; then
    fail "dry-run: no env dump" "env key present out=$OUT"
  elif json_has_key "$OUT" "PATH"; then
    fail "dry-run: no PATH key" "PATH key present out=$OUT"
  else
    pass "dry-run: prints argv, spawns nothing"
    pass "dry-run: no env or PATH keys"
  fi
  printf '%s' "$OUT" | "$NODE" -e '
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    const j = JSON.parse(raw.slice(raw.indexOf("{")));
    const cmd = j.command || [];
    if (cmd.indexOf("--no-subagents") < 0) process.exit(10);
    if (cmd.indexOf("--disable-web-search") >= 0) process.exit(11);
    if (cmd.indexOf("mcp__*") < 0) process.exit(12);
  '
  grokflags=$?
  if [ "$grokflags" -eq 0 ]; then
    pass "dry-run: grok read has --no-subagents and --deny mcp__*, no --disable-web-search"
  else
    fail "dry-run: grok read has --no-subagents and --deny mcp__*, no --disable-web-search" "node_exit=$grokflags cmd=$cmd0"
  fi
  printf '%s' "$OUT" | "$NODE" -e '
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    const j = JSON.parse(raw.slice(raw.indexOf("{")));
    const cmd = j.command || [];
    const idx = cmd.indexOf("--output-format");
    if (idx < 0 || cmd[idx + 1] !== "streaming-messages-json") process.exit(20);
  '
  if [ $? -eq 0 ]; then
    pass "dry-run: grok argv uses --output-format streaming-messages-json"
  else
    fail "dry-run: grok argv uses --output-format streaming-messages-json" "cmd=$cmd0"
  fi
else
  fail "dry-run: prints argv, spawns nothing" "exit=$EC out=$OUT"
fi
unset MOCK_SPAWN_MARKER

run_wrap codex --mode read --cwd "$PARSE_CWD" --session sess123 --run-dir "$PARSE_RUN/codex-session" --dry-run -- "hi"
if [ "$EC" -eq 0 ]; then
  printf '%s' "$OUT" | "$NODE" -e '
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    const j = JSON.parse(raw.slice(raw.indexOf("{")));
    const cmd = j.command || [];
    const cwd = process.argv[1];
    const last = require("path").join(process.argv[2], "last.txt");
    const expectedTail = ["exec", "-C", cwd, "--skip-git-repo-check", "--json", "-o", last, "-s", "read-only", "resume", "sess123", "-"];
    const got = cmd.slice(1);
    if (JSON.stringify(got) !== JSON.stringify(expectedTail)) {
      process.stderr.write("got=" + JSON.stringify(got) + "\nexpected=" + JSON.stringify(expectedTail) + "\n");
      process.exit(1);
    }
  ' "$PARSE_CWD" "$PARSE_RUN/codex-session"
  if [ $? -eq 0 ]; then
    pass "dry-run: codex --session exec options before resume"
  else
    fail "dry-run: codex --session exec options before resume" "out=$OUT"
  fi
else
  fail "dry-run: codex --session exec options before resume" "exit=$EC out=$OUT"
fi

MARKER="$TMPROOT/spawned-claude"
rm -f "$MARKER"
MOCK_SPAWN_MARKER="$MARKER"
export MOCK_SPAWN_MARKER
run_wrap claude --mode read --cwd "$PARSE_CWD" --model sonnet --dry-run -- "hi"
if [ "$EC" -eq 0 ]; then
  if [ -f "$MARKER" ]; then
    fail "dry-run: claude read argv" "mock was spawned"
  else
    printf '%s' "$OUT" | "$NODE" -e '
      const fs = require("fs");
      const raw = fs.readFileSync(0, "utf8");
      const j = JSON.parse(raw.slice(raw.indexOf("{")));
      const cmd = j.command || [];
      const has = (f) => cmd.indexOf(f) >= 0;
      const after = (f) => { const i = cmd.indexOf(f); return i < 0 ? null : cmd[i + 1]; };
      if (cmd[1] !== "-p") process.exit(10);
      if (!has("--safe-mode") || !has("--disable-slash-commands")) process.exit(11);
      if (!has("--verbose") || after("--output-format") !== "stream-json") process.exit(12);
      if (after("--permission-mode") !== "dontAsk") process.exit(13);
      if (after("--permission-prompts") !== "none") process.exit(14);
      if (after("--tools") !== "Read,Grep,Glob") process.exit(15);
      if (after("--model") !== "sonnet") process.exit(16);
      if (has("--cwd") || has("--bare") || has("--max-turns") || has("acceptEdits")) process.exit(17);
      if (has("--dangerously-skip-permissions")) process.exit(18);
    '
    if [ $? -eq 0 ]; then
      pass "dry-run: claude read has --safe-mode --tools, no --cwd/--bare/--max-turns"
    else
      fail "dry-run: claude read has --safe-mode --tools, no --cwd/--bare/--max-turns" "out=$OUT"
    fi
  fi
else
  fail "dry-run: claude read argv" "exit=$EC out=$OUT"
fi

run_wrap claude --mode write --cwd "$PARSE_CWD" --model sonnet --dry-run -- "hi"
if [ "$EC" -eq 0 ]; then
  printf '%s' "$OUT" | "$NODE" -e '
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    const j = JSON.parse(raw.slice(raw.indexOf("{")));
    const cmd = j.command || [];
    const has = (f) => cmd.indexOf(f) >= 0;
    const after = (f) => { const i = cmd.indexOf(f); return i < 0 ? null : cmd[i + 1]; };
    if (after("--permission-mode") !== "bypassPermissions") process.exit(10);
    if (after("--max-budget-usd") !== "5") process.exit(11);
    if (has("acceptEdits") || has("--cwd")) process.exit(12);
    if (!has("--safe-mode") || after("--permission-prompts") !== "none") process.exit(14);
    if (after("--output-format") !== "stream-json" || !has("--verbose")) process.exit(15);
    if (cmd[1] !== "-p") process.exit(16);
    if (has("--tools") || has("--bare") || has("--max-turns") || has("--dangerously-skip-permissions")) process.exit(17);
  '
  if [ $? -eq 0 ]; then
    pass "dry-run: claude write is bypassPermissions + --max-budget-usd 5, no acceptEdits/--cwd"
  else
    fail "dry-run: claude write is bypassPermissions + --max-budget-usd 5, no acceptEdits/--cwd" "out=$OUT"
  fi
else
  fail "dry-run: claude write argv" "exit=$EC out=$OUT"
fi
unset MOCK_SPAWN_MARKER

# ---------------------------------------------------------------------------
# quota (codex fixture) + answer-text must not classify as quota
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=quota
export MOCK_BEHAVIOR
run_wrap codex --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/quota" -- "hi"
if [ "$EC" -eq 1 ]; then
  cls=$(json_field "$OUT" "error.class")
  ok=$(json_field "$OUT" "ok")
  if [ "$cls" = "quota_exceeded" ] && [ "$ok" = "false" ]; then
    pass "quota: codex out-of-credits → quota_exceeded"
  else
    fail "quota: codex out-of-credits → quota_exceeded" "class=$cls ok=$ok out=$OUT"
  fi
else
  fail "quota: codex out-of-credits → quota_exceeded" "exit=$EC out=$OUT err=$ERR"
fi

MOCK_BEHAVIOR=quota_in_text
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/quota-text" -- "hi"
if [ "$EC" -eq 0 ]; then
  ok=$(json_field "$OUT" "ok")
  err=$(json_field "$OUT" "error")
  text=$(json_field "$OUT" "text")
  if [ "$ok" = "true" ] && [ -z "$err" ] && [ "$text" = "The quota and rate limit for login is fine." ]; then
    pass "quota: answer text mentioning quota/rate limit/login is ok"
  else
    fail "quota: answer text mentioning quota/rate limit/login is ok" "ok=$ok error=$err text=$text out=$OUT"
  fi
  if json_is_null_key "$OUT" "costUsd"; then
    pass "grok: total_cost_usd 0 on the wire maps to costUsd null (key present, strictly null)"
  else
    fail "grok: total_cost_usd 0 on the wire maps to costUsd null (key present, strictly null)" "out=$OUT"
  fi
else
  fail "quota: answer text mentioning quota/rate limit/login is ok" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# grok DEFECT 1: streaming-messages-json dual-parse
# ---------------------------------------------------------------------------

# error result line (is_error + errors[], NO `result` key): must NOT be
# retried as an empty success, must classify as a failure, and errorMessage
# must come only from errors[] (never the NDJSON blob).
MOCK_BEHAVIOR=error_result
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-error-result" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  retried=$(json_field "$OUT" "emptyRetried")
  cls=$(json_field "$OUT" "error.class")
  msg=$(json_field "$OUT" "error.message")
  if [ "$ok" = "false" ] && [ "$retried" = "false" ] && [ "$cls" = "backend_failed" ] \
    && [ "$msg" = "Reached maximum turns (120) without completing the task." ]; then
    pass "grok: error result line (no result key) is a failure, not empty-retried, errorMessage from errors[]"
  else
    fail "grok: error result line (no result key) is a failure, not empty-retried, errorMessage from errors[]" \
      "ok=$ok emptyRetried=$retried class=$cls message=$msg out=$OUT"
  fi
else
  fail "grok: error result line (no result key) is a failure, not empty-retried, errorMessage from errors[]" "exit=$EC out=$OUT err=$ERR"
fi

# quota wording inside errors[] still classifies as quota_exceeded (not a
# generic backend_failed / parse_error), and errorMessage is the errors[] text.
MOCK_BEHAVIOR=quota
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-quota-result" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  msg=$(json_field "$OUT" "error.message")
  if [ "$ok" = "false" ] && [ "$cls" = "quota_exceeded" ] && [ "$msg" = "quota exceeded (429): rate limit hit" ]; then
    pass "grok: is_error result with quota wording in errors[] -> quota_exceeded"
  else
    fail "grok: is_error result with quota wording in errors[] -> quota_exceeded" "ok=$ok class=$cls message=$msg out=$OUT"
  fi
else
  fail "grok: is_error result with quota wording in errors[] -> quota_exceeded" "exit=$EC out=$OUT err=$ERR"
fi

# old flat `--output-format json` shape must still parse via the fallback
# branch (--json-schema, --extra-args, or an older grok CLI on PATH).
MOCK_BEHAVIOR=legacy_json
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-legacy-json" -- "hi"
if [ "$EC" -eq 0 ]; then
  text=$(json_field "$OUT" "text")
  sid=$(json_field "$OUT" "sessionId")
  ok=$(json_field "$OUT" "ok")
  if [ "$text" = "OK" ] && [ "$sid" = "01a083f0-1c50-7e01-af19-c746a5bb6e91" ] && [ "$ok" = "true" ]; then
    pass "grok: old flat json stdout still parses via fallback"
  else
    fail "grok: old flat json stdout still parses via fallback" "text=$text sid=$sid ok=$ok out=$OUT"
  fi
else
  fail "grok: old flat json stdout still parses via fallback" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# F5: retry-guard hardening — the DEFECT 1 "error_result" test above uses a
# mock that EXITS 1, so `successfulExit` alone already blocks the empty
# retry there; it does not prove the `failed` flag matters. These three cases
# all EXIT 0 with a structured failure, and split is_error/subtype so each
# half of the OR is proven independently.
# ---------------------------------------------------------------------------

MOCK_BEHAVIOR=error_result_exit0
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-error-result-exit0" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  retried=$(json_field "$OUT" "emptyRetried")
  cls=$(json_field "$OUT" "error.class")
  if [ "$ok" = "false" ] && [ "$retried" = "false" ] && [ "$cls" = "backend_failed" ]; then
    pass "F5: exit-0 structured failure (is_error+errors[]) is not empty-retried"
  else
    fail "F5: exit-0 structured failure (is_error+errors[]) is not empty-retried" "ok=$ok emptyRetried=$retried class=$cls out=$OUT"
  fi
else
  fail "F5: exit-0 structured failure (is_error+errors[]) is not empty-retried" "exit=$EC out=$OUT err=$ERR"
fi

MOCK_BEHAVIOR=is_error_only
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-is-error-only" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  retried=$(json_field "$OUT" "emptyRetried")
  cls=$(json_field "$OUT" "error.class")
  if [ "$ok" = "false" ] && [ "$retried" = "false" ] && [ "$cls" = "backend_failed" ]; then
    pass "F5: is_error:true ALONE (normal subtype) marks failed, not empty-retried"
  else
    fail "F5: is_error:true ALONE (normal subtype) marks failed, not empty-retried" "ok=$ok emptyRetried=$retried class=$cls out=$OUT"
  fi
else
  fail "F5: is_error:true ALONE (normal subtype) marks failed, not empty-retried" "exit=$EC out=$OUT err=$ERR"
fi

MOCK_BEHAVIOR=error_subtype_only
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-error-subtype-only" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  retried=$(json_field "$OUT" "emptyRetried")
  cls=$(json_field "$OUT" "error.class")
  if [ "$ok" = "false" ] && [ "$retried" = "false" ] && [ "$cls" = "backend_failed" ]; then
    pass "F5: subtype:error_* ALONE (is_error false) marks failed, not empty-retried"
  else
    fail "F5: subtype:error_* ALONE (is_error false) marks failed, not empty-retried" "ok=$ok emptyRetried=$retried class=$cls out=$OUT"
  fi
else
  fail "F5: subtype:error_* ALONE (is_error false) marks failed, not empty-retried" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# grok DEFECT 2: UNKNOWN_SESSION_RE matches grok's real wording, retry fires
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --session bogus-session --run-dir "$PARSE_RUN/grok-session-retry" -- "hi"
if [ "$EC" -eq 0 ]; then
  ok=$(json_field "$OUT" "ok")
  retried=$(json_field "$OUT" "sessionRetried")
  text=$(json_field "$OUT" "text")
  if [ "$ok" = "true" ] && [ "$retried" = "true" ] && [ "$text" = "OK" ]; then
    pass "grok: type:error Couldn't start session -> unknown-session path, sessionRetried true"
  else
    fail "grok: type:error Couldn't start session -> unknown-session path, sessionRetried true" "ok=$ok sessionRetried=$retried text=$text out=$OUT"
  fi
else
  fail "grok: type:error Couldn't start session -> unknown-session path, sessionRetried true" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# F1: unknown-session detection destroys successful runs
# ---------------------------------------------------------------------------

# (a)+(b) benign stderr wording that used to false-positive as unknown-session:
# a genuinely successful run must stay ok:true.
MOCK_BEHAVIOR=benign_session_stderr
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-benign-stderr" -- "hi"
if [ "$EC" -eq 0 ]; then
  ok=$(json_field "$OUT" "ok")
  text=$(json_field "$OUT" "text")
  err=$(json_field "$OUT" "error")
  if [ "$ok" = "true" ] && [ "$text" = "OK" ] && [ -z "$err" ]; then
    pass "F1: benign stderr 'failed to restore session cache; recovered' stays ok:true"
  else
    fail "F1: benign stderr 'failed to restore session cache; recovered' stays ok:true" "ok=$ok text=$text error=$err out=$OUT"
  fi
else
  fail "F1: benign stderr 'failed to restore session cache; recovered' stays ok:true" "exit=$EC out=$OUT err=$ERR"
fi

# (b) a real auth failure phrased with "Couldn't start session" must classify
# as auth_required, NOT unknown-session (the narrowed regex no longer matches
# "couldn't start session" on its own).
MOCK_BEHAVIOR=session_auth_401
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-auth-401" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  if [ "$ok" = "false" ] && [ "$cls" = "auth_required" ]; then
    pass "F1: 'Couldn't start session: unauthorized (401)' -> auth_required, not unknown-session"
  else
    fail "F1: 'Couldn't start session: unauthorized (401)' -> auth_required, not unknown-session" "ok=$ok class=$cls out=$OUT"
  fi
else
  fail "F1: 'Couldn't start session: unauthorized (401)' -> auth_required, not unknown-session" "exit=$EC out=$OUT err=$ERR"
fi

# (b) each surviving UNKNOWN_SESSION_RE alternative, exercised independently.
UNKNOWN_SESSION_PHRASES=(
  "unknown session for this workspace"
  "invalid session token supplied"
  "session not found on server"
  "no rollout found for id abc123"
  "session get failed: 500"
  "no session id or title matched \"xyz\" for this directory"
)
for phrase in "${UNKNOWN_SESSION_PHRASES[@]}"; do
  MOCK_BEHAVIOR=session_error_custom
  MOCK_SESSION_ERROR_MSG="$phrase"
  export MOCK_BEHAVIOR MOCK_SESSION_ERROR_MSG
  run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-unknown-$(echo "$phrase" | tr -c 'a-zA-Z0-9' '_')" -- "hi"
  if [ "$EC" -eq 1 ]; then
    ok=$(json_field "$OUT" "ok")
    cls=$(json_field "$OUT" "error.class")
    msg=$(json_field "$OUT" "error.message")
    if [ "$ok" = "false" ] && [ "$cls" = "backend_failed" ] && [ "$msg" = "$phrase" ]; then
      pass "F1: UNKNOWN_SESSION_RE alternative '$phrase' classifies as unknown-session"
    else
      fail "F1: UNKNOWN_SESSION_RE alternative '$phrase' classifies as unknown-session" "ok=$ok class=$cls message=$msg out=$OUT"
    fi
  else
    fail "F1: UNKNOWN_SESSION_RE alternative '$phrase' classifies as unknown-session" "exit=$EC out=$OUT err=$ERR"
  fi
done
unset MOCK_SESSION_ERROR_MSG

# ---------------------------------------------------------------------------
# F2: a later structured error must win over an earlier successful result
# (stream order decides, not a type preference).
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=result_then_error
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-result-then-error" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  text=$(json_field "$OUT" "text")
  if [ "$ok" = "false" ] && [ "$cls" = "quota_exceeded" ]; then
    pass "F2: a later type:error line wins over an earlier type:result line"
  else
    fail "F2: a later type:error line wins over an earlier type:result line" "ok=$ok class=$cls text=$text out=$OUT"
  fi
else
  fail "F2: a later type:error line wins over an earlier type:result line" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# F3: a stream truncated after the init line must not masquerade as the
# legacy flat-json fallback, must not be empty-retried, and must preserve the
# session id for resuming.
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=init_only
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-init-only" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  sid=$(json_field "$OUT" "sessionId")
  retried=$(json_field "$OUT" "emptyRetried")
  if [ "$ok" = "false" ] && [ "$cls" = "parse_error" ] && [ "$sid" = "mock-init-only" ] && [ "$retried" = "false" ]; then
    pass "F3: init-line-only stream -> parsed:false, sessionId preserved, not empty-retried"
  else
    fail "F3: init-line-only stream -> parsed:false, sessionId preserved, not empty-retried" "ok=$ok class=$cls sessionId=$sid emptyRetried=$retried out=$OUT"
  fi
else
  fail "F3: init-line-only stream -> parsed:false, sessionId preserved, not empty-retried" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# F4: exit-0 + truly empty stdout + an incidental auth-shaped stderr warning
# must classify as the honest parse_error, not auth_required.
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=truly_empty_auth_stderr
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/grok-empty-auth-stderr" -- "hi"
if [ "$EC" -eq 1 ]; then
  ok=$(json_field "$OUT" "ok")
  cls=$(json_field "$OUT" "error.class")
  if [ "$ok" = "false" ] && [ "$cls" = "parse_error" ]; then
    pass "F4: exit-0 + empty stdout + stderr auth wording -> parse_error, not auth_required"
  else
    fail "F4: exit-0 + empty stdout + stderr auth wording -> parse_error, not auth_required" "ok=$ok class=$cls out=$OUT"
  fi
else
  fail "F4: exit-0 + empty stdout + stderr auth wording -> parse_error, not auth_required" "exit=$EC out=$OUT err=$ERR"
fi

MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR

# ---------------------------------------------------------------------------
# grok DEFECT 3: --brief-file cannot be silently overridden by a trailing brief
# ---------------------------------------------------------------------------
BRIEF_FILE="$TMPROOT/brief.txt"
printf 'the real plan\n' > "$BRIEF_FILE"
run_wrap grok --mode read --cwd "$PARSE_CWD" --brief-file "$BRIEF_FILE" -- "trailing brief"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then
    pass "usage: --brief-file with trailing brief exits 2 instead of silently picking one"
  else
    fail "usage: --brief-file with trailing brief exits 2 instead of silently picking one" "error.class=$cls out=$OUT"
  fi
else
  fail "usage: --brief-file with trailing brief exits 2 instead of silently picking one" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap grok --mode read --cwd "$PARSE_CWD" --brief-file "$BRIEF_FILE" "positional brief"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "usage" ]; then
    pass "usage: --brief-file with positional brief exits 2 instead of silently picking one"
  else
    fail "usage: --brief-file with positional brief exits 2 instead of silently picking one" "error.class=$cls out=$OUT"
  fi
else
  fail "usage: --brief-file with positional brief exits 2 instead of silently picking one" "exit=$EC out=$OUT err=$ERR"
fi

run_wrap grok --mode read --cwd "$PARSE_CWD" --brief-file "$BRIEF_FILE" --run-dir "$PARSE_RUN/brief-file-only"
if [ "$EC" -eq 0 ]; then
  brief_written=$(cat "$PARSE_RUN/brief-file-only/stdin.txt" 2>/dev/null)
  if [ "$brief_written" = "the real plan" ]; then
    pass "brief-file: used alone still reads the file"
  else
    fail "brief-file: used alone still reads the file" "stdin.txt='$brief_written' out=$OUT"
  fi
else
  fail "brief-file: used alone still reads the file" "exit=$EC out=$OUT err=$ERR"
fi

# ---------------------------------------------------------------------------
# recursion_guard: DELEGATE_DEPTH refuses before spawn
# ---------------------------------------------------------------------------
MARKER="$TMPROOT/spawned-depth"
rm -f "$MARKER"
MOCK_SPAWN_MARKER="$MARKER"
export MOCK_SPAWN_MARKER
MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR
DELEGATE_DEPTH=1 run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/depth" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "recursion_guard" ] && [ ! -f "$MARKER" ]; then
    pass "recursion_guard: DELEGATE_DEPTH=1 exits 2 without spawning"
  else
    fail "recursion_guard: DELEGATE_DEPTH=1 exits 2 without spawning" "class=$cls spawned=$( [ -f "$MARKER" ] && echo yes || echo no ) out=$OUT"
  fi
else
  fail "recursion_guard: DELEGATE_DEPTH=1 exits 2 without spawning" "exit=$EC out=$OUT"
fi

rm -f "$MARKER"
DEPTH_FILE="$TMPROOT/child-depth"
rm -f "$DEPTH_FILE"
MOCK_DEPTH_FILE="$DEPTH_FILE"
export MOCK_DEPTH_FILE
DELEGATE_DEPTH=1 DELEGATE_MAX_DEPTH=2 run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/depth-ok" -- "hi"
if [ "$EC" -eq 0 ]; then
  ok=$(json_field "$OUT" "ok")
  child_depth=$(cat "$DEPTH_FILE" 2>/dev/null)
  if [ "$ok" = "true" ] && [ -f "$MARKER" ] && [ "$child_depth" = "2" ]; then
    pass "recursion_guard: DELEGATE_MAX_DEPTH=2 allows depth 1"
    pass "recursion_guard: child env DELEGATE_DEPTH is current+1"
  else
    fail "recursion_guard: DELEGATE_MAX_DEPTH=2 allows depth 1 / child depth+1" "ok=$ok spawned=$( [ -f "$MARKER" ] && echo yes || echo no ) child_depth=$child_depth out=$OUT"
  fi
else
  fail "recursion_guard: DELEGATE_MAX_DEPTH=2 allows depth 1 / child depth+1" "exit=$EC out=$OUT"
fi
unset MOCK_SPAWN_MARKER MOCK_DEPTH_FILE

# ---------------------------------------------------------------------------
# ok / exit-code invariant
# ---------------------------------------------------------------------------
MOCK_BEHAVIOR=ok
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/inv-ok" -- "hi"
ok=$(json_field "$OUT" "ok")
if [ "$EC" -eq 0 ] && [ "$ok" = "true" ]; then
  pass "invariant: ok true iff exit 0"
else
  fail "invariant: ok true iff exit 0" "exit=$EC ok=$ok"
fi

MOCK_BEHAVIOR=empty
export MOCK_BEHAVIOR
run_wrap grok --mode read --cwd "$PARSE_CWD" --run-dir "$PARSE_RUN/inv-bad" -- "hi"
ok=$(json_field "$OUT" "ok")
if [ "$EC" -ne 0 ] && [ "$ok" = "false" ]; then
  pass "invariant: ok false iff non-zero exit"
else
  fail "invariant: ok false iff non-zero exit" "exit=$EC ok=$ok"
fi

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
