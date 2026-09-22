'use strict';

/**
 * Shared primitives for delegate.js (one-shot CLIs) and acp.js (ACP JSON-RPC).
 * Zero npm dependencies. Not a launch file.
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEXT_LIMIT = 20000;
const KILL_GRACE_MS = 5000;
const DEFAULT_TIMEOUT_SECS = 1800;
const DEFAULT_MAX_DEPTH = 1;
const HANDSHAKE_TIMEOUT_MS = 10000;
const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.grok', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.opencode', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
];
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];
const ALLOWED_PATHEXT = new Set(DEFAULT_PATHEXT);
const AUTH_RE = /unauthorized|\b401\b|not authenticated|api key|\blogin\b/i;
const QUOTA_RE = /\b429\b|rate limit|quota|out of credits/i;
const UNKNOWN_SESSION_RE = /unknown session|invalid session|session not found|no rollout found|session get failed|no session id or title matched/i;
const PLUGIN_VERSION = '1.0.0';

let emitted = false;
let activeChild = null;
let usageTextFn = () =>
  [
    'Usage: --mode read|write --cwd /abs [options] [-- brief]',
    'Options: --session ID --worktree [NAME] --timeout SECS --brief-file PATH',
    '         --extra-args "…" --dry-run --run-dir PATH',
  ].join('\n');

function setUsageText(fn) {
  usageTextFn = fn;
}

function usageText() {
  return usageTextFn();
}

function recursionDepth() {
  const n = Number(process.env.DELEGATE_DEPTH);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function maxRecursionDepth() {
  const n = Number(process.env.DELEGATE_MAX_DEPTH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DEPTH;
}

function childEnv() {
  const env = Object.assign({}, process.env);
  env.DELEGATE_DEPTH = String(recursionDepth() + 1);
  return env;
}

function extraBinDirs() {
  if (process.env.DELEGATE_NO_EXTRA_BIN_DIRS === '1') return [];
  return EXTRA_BIN_DIRS;
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function randHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function isExecutableFile(file, platform) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if ((platform || process.platform) === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function parsePathext(raw) {
  const src = raw == null || String(raw).trim() === '' ? DEFAULT_PATHEXT.join(';') : String(raw);
  const out = [];
  const seen = new Set();
  for (const part of src.split(';')) {
    let ext = part.trim();
    if (!ext) continue;
    if (ext[0] !== '.') ext = `.${ext}`;
    const key = ext.toUpperCase();
    if (!ALLOWED_PATHEXT.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(ext);
  }
  return out.length ? out : DEFAULT_PATHEXT.slice();
}

function namesToTry(name, platform, pathextRaw) {
  if (!name) return [];
  if ((platform || process.platform) !== 'win32') return [name];
  // path.win32.extname('.codex') === '' — a leading-dot name is not an extension.
  if (path.win32.extname(name)) return [name];
  return parsePathext(pathextRaw).map((ext) => name + ext);
}

function looksLikePath(name) {
  if (!name) return false;
  // Separators / absolute only. A leading-dot token (".codex") is a PATH name,
  // not a relative path; "./codex" and ".\\codex" already contain a separator.
  if (path.isAbsolute(name)) return true;
  return name.includes('/') || name.includes('\\');
}

function findBinary(name, opts) {
  if (!name) return null;
  const platform = (opts && opts.platform) || process.platform;
  const env = (opts && opts.env) || process.env;
  const extra = opts && Array.isArray(opts.extraDirs) ? opts.extraDirs : extraBinDirs();
  const variants = namesToTry(name, platform, env.PATHEXT);

  if (looksLikePath(name)) {
    for (const v of variants) {
      const abs = path.isAbsolute(v) ? v : path.resolve(v);
      if (isExecutableFile(abs, platform)) return abs;
    }
    return null;
  }

  const pathDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = pathDirs.concat(extra);
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const v of variants) {
      const candidate = path.join(dir, v);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function quoteCmdArg(s) {
  // Always quote. cmd /s /c "..." strips the first and last quote; mixed
  // quoted/unquoted tokens then leave a dangling quote on args with spaces.
  return `"${String(s).replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function spawnFileArgs(bin, args, opts) {
  const argv = args || [];
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'win32') return { file: bin, argv, spawnOpts: {} };
  const ext = path.win32.extname(bin).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file: bin, argv, spawnOpts: {} };
  const env = (opts && opts.env) || process.env;
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
  const inner = [quoteCmdArg(bin)].concat(argv.map(quoteCmdArg)).join(' ');
  return {
    file: comspec,
    argv: ['/d', '/s', '/c', `"${inner}"`],
    spawnOpts: { windowsVerbatimArguments: true },
  };
}

function splitShellWords(str) {
  if (!str) return [];
  const out = [];
  let cur = '';
  let quote = null;
  let escape = false;
  for (const ch of str) {
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (escape) cur += '\\';
  if (cur.length) out.push(cur);
  return out;
}

function clipText(text) {
  const s = text == null ? '' : String(text);
  if (s.length <= TEXT_LIMIT) return { text: s, truncated: false };
  return { text: s.slice(0, TEXT_LIMIT), truncated: true };
}

function tailLines(s, n) {
  if (!s) return '';
  const lines = String(s).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function isEmptyText(t) {
  return !String(t || '').trim();
}

function mkdir0700(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* umask / platform */
  }
}

function emit(envelope, code) {
  if (emitted) {
    process.exit(code);
    return;
  }
  emitted = true;
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  process.exit(code);
}

function baseEnvelope(partial) {
  return Object.assign(
    {
      ok: false,
      backend: null,
      mode: null,
      model: null,
      cwd: null,
      worktree: null,
      command: [],
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      text: '',
      textTruncated: false,
      textFile: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      emptyRetried: false,
      sessionRetried: false,
      gitStatus: null,
      stderrTail: '',
      rawLog: null,
      error: null,
    },
    partial
  );
}

function failUsage(message, extra) {
  emit(
    baseEnvelope(
      Object.assign(
        {
          error: { class: 'usage', message, hint: usageText() },
          exitCode: 2,
        },
        extra || {}
      )
    ),
    2
  );
}

function takeValue(argv, i, eqVal) {
  if (eqVal !== undefined && eqVal !== '') return { value: eqVal, next: i };
  if (i >= argv.length) return { value: null, next: i, missing: true };
  return { value: argv[i], next: i + 1 };
}

function git(cwd, gitArgs, timeoutMs) {
  return spawnSync('git', ['-C', cwd].concat(gitArgs), {
    encoding: 'utf8',
    timeout: timeoutMs || 15000,
    env: process.env,
  });
}

function isGitRepo(cwd) {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree'], 8000);
  return r.status === 0 && String(r.stdout || '').trim() === 'true';
}

function captureGitStatus(cwd) {
  const r = git(cwd, ['status', '--short'], 15000);
  if (r.status !== 0) return '';
  return r.stdout || '';
}

function ensureWorktree(cwd, name) {
  if (!isGitRepo(cwd)) {
    return { error: { class: 'usage', message: `--cwd is not a git repository (required for --worktree)`, hint: 'pass a git checkout as --cwd' } };
  }
  const wtPath = `${cwd}-wt-${name}`;
  const branch = `delegate/${name}`;
  if (fs.existsSync(wtPath)) {
    return { path: wtPath, branch, created: false };
  }
  const branchExists = git(cwd, ['rev-parse', '--verify', '--quiet', branch], 8000);
  let add;
  if (branchExists.status === 0) {
    add = git(cwd, ['worktree', 'add', wtPath, branch], 30000);
  } else {
    add = git(cwd, ['worktree', 'add', '-b', branch, wtPath], 30000);
  }
  if (add.status !== 0) {
    const msg = String(add.stderr || add.stdout || 'git worktree add failed').trim();
    return { error: { class: 'usage', message: msg, hint: 'check git worktree add output' } };
  }
  return { path: wtPath, branch, created: true };
}

function killProcessTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function forceKillProcessTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function setActiveChild(child) {
  activeChild = child || null;
}

function getActiveChild() {
  return activeChild;
}

function killActiveChildGroup() {
  if (!activeChild) return;
  killProcessTree(activeChild);
  forceKillProcessTree(activeChild);
}

process.on('SIGTERM', () => {
  killActiveChildGroup();
  process.exit(143);
});
process.on('SIGINT', () => {
  killActiveChildGroup();
  process.exit(130);
});

function appendRaw(rawLogPath, tag, chunk) {
  if (!rawLogPath) return;
  try {
    fs.appendFileSync(rawLogPath, `[${tag}] ${chunk}`);
  } catch {
    /* ignore */
  }
}

function writeRunFiles(runDir, { argv, brief, envelope, text }) {
  mkdir0700(runDir);
  fs.writeFileSync(path.join(runDir, 'argv.json'), JSON.stringify(argv, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'stdin.txt'), brief == null ? '' : String(brief));
  fs.writeFileSync(path.join(runDir, 'text.md'), text == null ? '' : String(text));
  fs.writeFileSync(path.join(runDir, 'envelope.json'), JSON.stringify(envelope, null, 2) + '\n');
}

function defaultRunDir(backend, runDirOpt) {
  const pluginData =
    process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'delegate-model');
  return runDirOpt || path.join(pluginData, 'runs', `${nowStamp()}-${backend}-${randHex(3)}`);
}

function resolveTimeoutSecs(optsTimeout) {
  if (optsTimeout != null) return optsTimeout;
  if (Number(process.env.DELEGATE_TIMEOUT_SECS) > 0) return Number(process.env.DELEGATE_TIMEOUT_SECS);
  return DEFAULT_TIMEOUT_SECS;
}

function refuseIfNested(extra) {
  const depth = recursionDepth();
  const maxDepth = maxRecursionDepth();
  if (depth < maxDepth) return;
  emit(
    baseEnvelope(
      Object.assign(
        {
          error: {
            class: 'recursion_guard',
            message: `DELEGATE_DEPTH=${depth} >= DELEGATE_MAX_DEPTH=${maxDepth}; refusing nested delegation`,
            hint: 'unset DELEGATE_DEPTH if you exported it in your shell; raise DELEGATE_MAX_DEPTH to allow one more nested level',
          },
          exitCode: 2,
        },
        extra || {}
      )
    ),
    2
  );
}

function prepareCwd(opts, extra) {
  if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
    failUsage('--cwd is not a directory', Object.assign({ cwd: opts.cwd }, extra || {}));
  }
  let effectiveCwd = opts.cwd;
  let worktreeInfo = null;
  if (opts.worktreeRequested && !opts.dryRun) {
    const wt = ensureWorktree(opts.cwd, opts.worktreeName);
    if (wt.error) {
      emit(
        baseEnvelope(
          Object.assign(
            {
              cwd: opts.cwd,
              error: wt.error,
              exitCode: 2,
            },
            extra || {}
          )
        ),
        2
      );
    }
    worktreeInfo = { path: wt.path, branch: wt.branch, created: wt.created };
    effectiveCwd = wt.path;
  } else if (opts.worktreeRequested && opts.dryRun) {
    effectiveCwd = `${opts.cwd}-wt-${opts.worktreeName}`;
    worktreeInfo = { path: effectiveCwd, branch: `delegate/${opts.worktreeName}`, created: null };
  }
  return { effectiveCwd, worktreeInfo };
}

function waitForChildExit(child, graceMs) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('close', finish);
    killProcessTree(child);
    setTimeout(() => {
      forceKillProcessTree(child);
      setTimeout(finish, 200);
    }, graceMs == null ? KILL_GRACE_MS : graceMs);
  });
}

module.exports = {
  spawn,
  spawnSync,
  fs,
  os,
  path,
  TEXT_LIMIT,
  KILL_GRACE_MS,
  DEFAULT_TIMEOUT_SECS,
  DEFAULT_MAX_DEPTH,
  HANDSHAKE_TIMEOUT_MS,
  EXTRA_BIN_DIRS,
  DEFAULT_PATHEXT,
  AUTH_RE,
  QUOTA_RE,
  UNKNOWN_SESSION_RE,
  PLUGIN_VERSION,
  setUsageText,
  usageText,
  recursionDepth,
  maxRecursionDepth,
  childEnv,
  extraBinDirs,
  nowStamp,
  randHex,
  isExecutableFile,
  parsePathext,
  namesToTry,
  looksLikePath,
  findBinary,
  quoteCmdArg,
  spawnFileArgs,
  splitShellWords,
  clipText,
  tailLines,
  isEmptyText,
  mkdir0700,
  emit,
  baseEnvelope,
  failUsage,
  takeValue,
  git,
  isGitRepo,
  captureGitStatus,
  ensureWorktree,
  killProcessTree,
  forceKillProcessTree,
  setActiveChild,
  getActiveChild,
  killActiveChildGroup,
  appendRaw,
  writeRunFiles,
  defaultRunDir,
  resolveTimeoutSecs,
  refuseIfNested,
  prepareCwd,
  waitForChildExit,
};
