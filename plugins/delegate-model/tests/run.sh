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

chmod +x "$DELEGATE" "$MOCKS/grok" "$MOCKS/codex" "$MOCKS/opencode" 2>/dev/null || true

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
  export PATH
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

# ---------------------------------------------------------------------------
# not_installed
# ---------------------------------------------------------------------------
EMPTY_HOME="$TMPROOT/empty-home"
mkdir -p "$EMPTY_HOME"
HOME="$EMPTY_HOME" PATH= run_wrap grok --mode read --cwd "$TMPROOT" -- "hi"
if [ "$EC" -eq 2 ]; then
  cls=$(json_field "$OUT" "error.class")
  if [ "$cls" = "not_installed" ]; then pass "not_installed: empty PATH exits 2"; else fail "not_installed: empty PATH exits 2" "error.class=$cls out=$OUT"; fi
else
  fail "not_installed: empty PATH exits 2" "exit=$EC out=$OUT err=$ERR"
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
else
  fail "quota: answer text mentioning quota/rate limit/login is ok" "exit=$EC out=$OUT err=$ERR"
fi

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
