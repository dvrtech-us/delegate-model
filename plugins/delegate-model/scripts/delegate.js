#!/usr/bin/env node
'use strict';

/**
 * Delegate Model wrapper — one-shot spawn of grok / codex / opencode / claude.
 * Node >= 18, zero dependencies. Always prints one JSON envelope on stdout.
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const BACKENDS = new Set(['grok', 'codex', 'opencode', 'claude']);
const TEXT_LIMIT = 20000;
const KILL_GRACE_MS = 5000;
const DEFAULT_TIMEOUT_SECS = 1800;
const DEFAULT_MAX_DEPTH = 1;
const CLAUDE_WRITE_BUDGET_USD = '5';
const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.grok', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.opencode', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
];
const INSTALL_HINT = {
  grok: 'Install the grok CLI and ensure it is on PATH (https://x.ai).',
  codex: 'Install the Codex CLI: https://github.com/openai/codex',
  opencode: 'Install OpenCode: https://opencode.ai',
  claude: 'Install the Claude Code CLI: https://code.claude.com/docs/en/quickstart',
};
const AUTH_HINT = {
  grok: 'run `! grok login`',
  codex: 'run `! codex login`',
  opencode: 'run `! opencode providers login`',
  claude: 'run `! claude auth`',
};
const GROK_DEFAULT_MODEL = 'grok-composer-2.5-fast';
const OPENCODE_READ_PREFIX =
  '[READ-ONLY] Do not edit, write, create, or delete files. Do not run commands that change state. Answer from inspection only.\n\n';

const AUTH_RE = /unauthorized|\b401\b|not authenticated|api key|\blogin\b/i;
const QUOTA_RE = /\b429\b|rate limit|quota|out of credits/i;
const UNKNOWN_SESSION_RE = /unknown session|invalid session|session not found|no rollout found|session get failed|no session id or title matched/i;

let emitted = false;
let activeChild = null;

function usageText() {
  return [
    'Usage: delegate.js <grok|codex|opencode|claude> --mode read|write --cwd /abs [options] [-- brief]',
    'Options: --model ID --session ID --worktree [NAME] --timeout SECS --brief-file PATH',
    '         --extra-args "…" --dry-run --run-dir PATH',
  ].join('\n');
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

function usesStdinBrief(backend) {
  return backend === 'codex';
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

function isExecutableFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findBinary(name) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = pathDirs.concat(extraBinDirs());
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
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

function parseJsonc(raw) {
  let s = String(raw);
  let out = '';
  let i = 0;
  let quote = null;
  let escape = false;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}

function readFileIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
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

function parseCli(argv) {
  const opts = {
    backend: null,
    mode: null,
    cwd: null,
    model: null,
    session: null,
    worktreeRequested: false,
    worktreeName: null,
    timeout: null,
    briefFile: null,
    extraArgsRaw: '',
    dryRun: false,
    runDir: null,
    brief: '',
  };

  const args = argv.slice();
  if (!args.length) failUsage('missing backend');

  if (args[0] === '-h' || args[0] === '--help') failUsage('help');

  if (args[0] && !args[0].startsWith('-')) {
    opts.backend = args.shift();
  } else {
    failUsage('missing backend');
  }
  if (!BACKENDS.has(opts.backend)) {
    failUsage(`unknown backend: ${opts.backend}`, { backend: opts.backend });
  }

  let i = 0;
  const positional = [];
  while (i < args.length) {
    const a = args[i++];
    if (a === '--') {
      opts.brief = args.slice(i).join(' ');
      i = args.length;
      break;
    }
    if (a === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (a === '--worktree' || a.startsWith('--worktree=')) {
      opts.worktreeRequested = true;
      if (a.startsWith('--worktree=') && a.length > '--worktree='.length) {
        opts.worktreeName = a.slice('--worktree='.length);
        continue;
      }
      if (i < args.length && !args[i].startsWith('-')) {
        opts.worktreeName = args[i++];
      } else {
        opts.worktreeName = 't' + randHex(3);
      }
      continue;
    }

    const eq = a.indexOf('=');
    let key = a;
    let eqVal;
    if (a.startsWith('--') && eq > 2) {
      key = a.slice(0, eq);
      eqVal = a.slice(eq + 1);
    }

    const named = {
      '--mode': 'mode',
      '--cwd': 'cwd',
      '--model': 'model',
      '--session': 'session',
      '--timeout': 'timeout',
      '--brief-file': 'briefFile',
      '--extra-args': 'extraArgsRaw',
      '--run-dir': 'runDir',
    };
    if (named[key]) {
      const got = takeValue(args, i, eqVal);
      if (got.missing || got.value == null) failUsage(`${key} requires a value`, { backend: opts.backend });
      i = got.next;
      const field = named[key];
      if (field === 'timeout') {
        const n = Number(got.value);
        if (!Number.isFinite(n) || n <= 0) failUsage('--timeout must be a positive number of seconds', { backend: opts.backend });
        opts.timeout = n;
      } else {
        opts[field] = got.value;
      }
      continue;
    }

    if (a.startsWith('-')) failUsage(`unknown option: ${a}`, { backend: opts.backend });
    positional.push(a);
  }

  if (opts.briefFile && (opts.brief || positional.length)) {
    failUsage('--brief-file cannot be combined with a trailing/positional brief; pass only one', { backend: opts.backend });
  }
  if (opts.briefFile) {
    try {
      opts.brief = fs.readFileSync(opts.briefFile, 'utf8');
    } catch (err) {
      failUsage(`cannot read --brief-file: ${err.message}`, { backend: opts.backend });
    }
  } else if (!opts.brief && positional.length) {
    opts.brief = positional.join(' ');
  }

  if (!opts.mode || (opts.mode !== 'read' && opts.mode !== 'write')) {
    failUsage('--mode read|write is required', { backend: opts.backend, mode: opts.mode });
  }
  if (!opts.cwd) failUsage('--cwd /abs is required', { backend: opts.backend, mode: opts.mode });
  if (!path.isAbsolute(opts.cwd)) {
    failUsage('--cwd must be an absolute path', { backend: opts.backend, mode: opts.mode, cwd: opts.cwd });
  }
  if (opts.backend === 'opencode' && !opts.model) {
    failUsage('opencode requires --model provider/model', { backend: opts.backend, mode: opts.mode, cwd: opts.cwd });
  }
  if (opts.backend === 'claude' && !opts.model) {
    failUsage('claude requires --model (e.g. sonnet, opus, haiku)', { backend: opts.backend, mode: opts.mode, cwd: opts.cwd });
  }
  if (opts.worktreeRequested) {
    if (!opts.worktreeName || /[\\/]/.test(opts.worktreeName) || opts.worktreeName === '..') {
      failUsage('--worktree name must be a single path segment', { backend: opts.backend, mode: opts.mode, cwd: opts.cwd });
    }
  }
  return opts;
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

function runCommand({ bin, args, cwd, stdinData, timeoutMs, rawLogPath }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let sigkillTimer = null;
    let timeoutTimer = null;
    let child;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({
        exitCode: exitCode == null ? 1 : exitCode,
        signal: signal || null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
      });
    };

    try {
      // detached: child is its own process group so we can kill(-pid). If this
      // wrapper itself is killed (SIGKILL, e.g. the caller's timeout) the
      // SIGTERM/SIGINT handlers never run and the detached child keeps running.
      child = spawn(bin, args, {
        cwd: cwd || undefined,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      stderr = String(err.message || err);
      finish(1, null);
      return;
    }
    activeChild = child;

    child.stdout.on('data', (buf) => {
      const s = buf.toString();
      stdout += s;
      appendRaw(rawLogPath, 'stdout', s);
    });
    child.stderr.on('data', (buf) => {
      const s = buf.toString();
      stderr += s;
      appendRaw(rawLogPath, 'stderr', s);
    });
    child.on('error', (err) => {
      stderr += (stderr && !stderr.endsWith('\n') ? '\n' : '') + String(err.message || err);
      finish(1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    if (stdinData != null && stdinData !== '') {
      try {
        child.stdin.write(stdinData);
      } catch {
        /* ignore */
      }
    }
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      sigkillTimer = setTimeout(() => {
        forceKillProcessTree(child);
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}

function probeHttp(urlString, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlString);
    } catch {
      resolve(false);
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function loadOpencodeConfig(cwd) {
  const candidates = [
    path.join(cwd, 'opencode.jsonc'),
    path.join(cwd, 'opencode.json'),
    path.join(cwd, '.opencode.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.opencode', 'opencode.jsonc'),
  ];
  for (const p of candidates) {
    const raw = readFileIfExists(p);
    if (raw == null) continue;
    try {
      return parseJsonc(raw);
    } catch {
      continue;
    }
  }
  return null;
}

function providerBaseUrl(cfg, providerId) {
  if (!cfg || !providerId) return null;
  const block = cfg.provider && cfg.provider[providerId];
  if (!block) return null;
  if (block.options && block.options.baseURL) return block.options.baseURL;
  if (block.baseURL) return block.baseURL;
  return null;
}

async function preflightOpencode({ bin, cwd, mode, model, timeoutMs }) {
  const agent = mode === 'read' ? 'plan' : null;
  try {
    const listed = spawnSync(bin, ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 5000,
      env: childEnv(),
      cwd: cwd || undefined,
    });
    if (agent && listed.status === 0) {
      const body = `${listed.stdout || ''}\n${listed.stderr || ''}`;
      const has = new RegExp(`(^|\\n)\\s*${agent}\\b`, 'i').test(body);
      if (!has) {
        return {
          error: {
            class: 'backend_failed',
            message: `opencode agent '${agent}' not found`,
            hint: 'run `opencode agent list` and pick an existing agent',
          },
        };
      }
    }
  } catch {
    /* best effort */
  }

  if (!model) return null;
  const providerId = String(model).split('/')[0];
  if (providerId !== 'lmstudio' && providerId !== 'ollama') return null;
  const cfg = loadOpencodeConfig(cwd);
  const baseURL = providerBaseUrl(cfg, providerId);
  if (!baseURL) return null;
  let probe = baseURL;
  try {
    const u = new URL(baseURL);
    if (!u.pathname || u.pathname === '/') u.pathname = '/v1/models';
    else if (!/\/models\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/$/, '') + '/models';
    }
    probe = u.toString();
  } catch {
    probe = baseURL;
  }
  const ok = await probeHttp(probe, Math.min(2000, timeoutMs || 2000));
  if (!ok) {
    return {
      error: {
        class: 'provider_unreachable',
        message: `provider ${providerId} at ${baseURL} is unreachable`,
        hint: 'start the local provider (LM Studio / Ollama) or pick a cloud model',
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// grok adapter
// ---------------------------------------------------------------------------

function grokBuildArgs({ brief, cwd, mode, model, session, extraArgs }) {
  const args = ['-p', brief];
  if (mode === 'read') {
    // mcp__* is Claude-compat MCP deny-all; grok --help aliases --deny to --disallowedTools
    // and the real CLI accepts this RULE (parse-time check: no flag error).
    args.push(
      '--permission-mode',
      'dontAsk',
      '--deny',
      'Write',
      '--deny',
      'Edit',
      '--deny',
      'Bash',
      '--deny',
      'mcp__*',
      '--no-subagents'
    );
  } else {
    args.push('--always-approve', '--max-turns', '120');
  }
  args.push('--cwd', cwd, '--output-format', 'streaming-messages-json');
  if (model) args.push('-m', model);
  if (session) args.push('-r', session);
  return args.concat(extraArgs);
}

function grokParseFallbackFlatJson(trimmed) {
  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { parsed: false, text: '', sessionId: null, usage: null, costUsd: null, failed: false, errorMessage: 'stdout is not a JSON object' };
  }
  const errorMessage = obj.error ? String(obj.error.message || obj.error) : null;
  return {
    parsed: true,
    text: obj.text == null ? '' : String(obj.text),
    sessionId: obj.sessionId || null,
    usage: obj.usage || null,
    costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    failed: !!obj.error,
    errorMessage,
    hasStructuredError: !!obj.error,
    unknownSession: !!(errorMessage && UNKNOWN_SESSION_RE.test(errorMessage)),
    raw: obj,
  };
}

function grokParse(stdout, opts) {
  const zeroCostMeansNull = !opts || opts.zeroCostMeansNull !== false;
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    return { parsed: false, text: '', sessionId: null, usage: null, costUsd: null, failed: false, errorMessage: 'empty stdout' };
  }

  // 1) streaming-messages-json: NDJSON, one event per line (REUSE the shared splitter).
  const events = parseJsonlLines(trimmed);
  let systemSessionId = null;
  // Track the LAST terminal event (type:"result" or type:"error"), whichever
  // one it is — stream ORDER decides the winner, not a type preference.
  let lastTerminal = null; // { kind: 'result'|'error', ev }
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'system' && ev.session_id) systemSessionId = ev.session_id;
    if (ev.type === 'result') lastTerminal = { kind: 'result', ev };
    else if (ev.type === 'error') lastTerminal = { kind: 'error', ev };
  }

  // 2) the LAST terminal line wins. If it is a result line, the subtype/is_error
  // check applies; if it is an error line, it always means failure.
  if (lastTerminal && lastTerminal.kind === 'result') {
    const resultLine = lastTerminal.ev;
    const text = resultLine.result == null ? '' : String(resultLine.result);
    const sessionId = resultLine.session_id || systemSessionId || null;
    const usage = resultLine.usage || null;
    const rawCost = resultLine.total_cost_usd;
    const costUsd =
      typeof rawCost !== 'number' ? null : zeroCostMeansNull && rawCost === 0 ? null : rawCost;
    const failed = resultLine.is_error === true || String(resultLine.subtype || '').startsWith('error_');
    const errorMessage = Array.isArray(resultLine.errors)
      ? resultLine.errors
          .map((e) => (typeof e === 'string' ? e : (e && e.message) || ''))
          .filter(Boolean)
          .join('; ')
      : null;
    return {
      parsed: true,
      text,
      sessionId,
      usage,
      costUsd,
      failed,
      errorMessage,
      hasStructuredError: failed,
      unknownSession: !!(errorMessage && UNKNOWN_SESSION_RE.test(errorMessage)),
      raw: resultLine,
    };
  }

  // 3) else the LAST `{"type":"error", ...}` line (pre-session failure, or a
  // later structured error that superseded an earlier result line).
  if (lastTerminal && lastTerminal.kind === 'error') {
    const errorLine = lastTerminal.ev;
    const errorMessage = String(errorLine.message || '');
    return {
      parsed: true,
      text: '',
      sessionId: systemSessionId || null,
      usage: null,
      costUsd: null,
      failed: true,
      errorMessage,
      hasStructuredError: true,
      unknownSession: !!(errorMessage && UNKNOWN_SESSION_RE.test(errorMessage)),
      raw: errorLine,
    };
  }

  // 4) No terminal result/error line. If we saw NO recognizable streaming event
  // at all (no object with a string `type`), this is the old flat
  // `--output-format json` shape (--json-schema implies it, or --extra-args
  // overrode our flag) — fall back to that parser. Note this does NOT provide
  // older-CLI compatibility: a CLI too old for streaming-messages-json rejects
  // the flag at invocation, which no parser fallback can rescue.
  const sawStreamingEvent = events.some((ev) => ev && typeof ev === 'object' && typeof ev.type === 'string');
  if (!sawStreamingEvent) {
    return grokParseFallbackFlatJson(trimmed);
  }

  // Recognizable streaming events were seen, but the stream was cut off before
  // a terminal result/error line arrived. This is a parse failure — NOT a
  // structured backend failure — but the session id from the init line (if
  // any) is preserved so the caller can still resume.
  return {
    parsed: false,
    text: '',
    sessionId: systemSessionId || null,
    usage: null,
    costUsd: null,
    failed: false,
    errorMessage: 'incomplete stream: no terminal result line',
  };
}

function grokResolvedModel(model) {
  return model || GROK_DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// claude adapter
// ---------------------------------------------------------------------------

function claudeBuildArgs({ brief, mode, model, session, extraArgs }) {
  const args = ['-p', brief];
  args.push('--model', model);
  args.push('--output-format', 'stream-json', '--verbose');
  args.push('--permission-prompts', 'none');
  args.push('--safe-mode', '--disable-slash-commands');
  if (mode === 'read') {
    args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob');
  } else {
    args.push('--permission-mode', 'bypassPermissions', '--max-budget-usd', CLAUDE_WRITE_BUDGET_USD);
  }
  if (session) args.push('--resume', session);
  return args.concat(extraArgs);
}

function claudeParse(stdout) {
  // Claude's stream-json (and buffered json) terminal line is the same
  // type:result / type:error shape grok cloned. Do not inherit grok's
  // costUsd 0→null rule: Claude reports a real 0 when it means 0.
  return grokParse(stdout, { zeroCostMeansNull: false });
}

// ---------------------------------------------------------------------------
// codex adapter
// ---------------------------------------------------------------------------

function codexBuildArgs({ cwd, mode, model, session, extraArgs, lastTxtPath }) {
  // exec options must precede the `resume` subcommand: `exec -C ... resume ID -`
  const args = [
    'exec',
    '-C',
    cwd,
    '--skip-git-repo-check',
    '--json',
    '-o',
    lastTxtPath,
    '-s',
    mode === 'read' ? 'read-only' : 'workspace-write',
  ];
  if (model) args.push('-m', model);
  if (session) args.push('resume', session);
  args.push('-');
  return args.concat(extraArgs);
}

function parseJsonlLines(text) {
  const events = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* skip non-JSON */
    }
  }
  return events;
}

function codexParse(stdout, lastTxtPath) {
  const events = parseJsonlLines(stdout);
  let sessionId = null;
  let usage = null;
  let failed = false;
  let errorMessage = null;
  let unknownSession = false;
  let hasStructuredError = false;
  const agentTexts = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') {
      agentTexts.push(ev.item.text == null ? '' : String(ev.item.text));
    }
    if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
    if (ev.type === 'turn.failed') {
      failed = true;
      hasStructuredError = true;
      const msg = ev.error && ev.error.message ? String(ev.error.message) : 'turn.failed';
      errorMessage = errorMessage || msg;
      if (UNKNOWN_SESSION_RE.test(msg)) unknownSession = true;
    }
    if (ev.type === 'error') {
      failed = true;
      hasStructuredError = true;
      const msg = ev.message != null ? String(ev.message) : JSON.stringify(ev);
      errorMessage = errorMessage || msg;
      if (UNKNOWN_SESSION_RE.test(msg)) unknownSession = true;
    }
  }
  let text = agentTexts.length ? agentTexts[agentTexts.length - 1] : '';
  if (lastTxtPath) {
    const fromFile = readFileIfExists(lastTxtPath);
    if (fromFile != null && String(fromFile).length) text = fromFile.replace(/\s+$/, '');
  }
  const parsed = events.length > 0 || (lastTxtPath && readFileIfExists(lastTxtPath) != null);
  return {
    parsed,
    text,
    sessionId,
    usage,
    costUsd: null,
    failed,
    errorMessage,
    hasStructuredError,
    unknownSession,
  };
}

// ---------------------------------------------------------------------------
// opencode adapter
// ---------------------------------------------------------------------------

function opencodeBuildArgs({ brief, cwd, mode, model, session, extraArgs }) {
  const args = ['run', '--format', 'json', '--dir', cwd, '-m', model];
  if (session) args.push('-s', session);
  if (mode === 'read') args.push('--agent', 'plan', '--auto');
  else args.push('--auto');
  const message = mode === 'read' ? OPENCODE_READ_PREFIX + brief : brief;
  args.push(message);
  return args.concat(extraArgs);
}

function opencodeParse(stdout) {
  const events = parseJsonlLines(stdout);
  const texts = new Map();
  let lastMid = null;
  let stopMid = null;
  let sessionId = null;
  let errorMessage = null;
  let failed = false;
  let unknownSession = false;
  let hasStructuredError = false;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.sessionID) sessionId = ev.sessionID;
    const part = ev.part || {};
    const t = ev.type;
    if (t === 'text') {
      lastMid = part.messageID || lastMid;
      const mid = part.messageID || lastMid || '_';
      const prev = texts.get(mid) || '';
      texts.set(mid, prev + (part.text == null ? '' : String(part.text)));
    } else if (t === 'step_finish' && part.reason === 'stop') {
      stopMid = part.messageID || stopMid;
    } else if (t === 'error') {
      failed = true;
      hasStructuredError = true;
      errorMessage = ev.message ? String(ev.message) : JSON.stringify(ev);
      if (UNKNOWN_SESSION_RE.test(errorMessage)) unknownSession = true;
    }
  }
  const mid = stopMid || lastMid;
  const text = mid != null ? texts.get(mid) || '' : '';
  return {
    parsed: events.length > 0,
    text,
    sessionId,
    usage: null,
    costUsd: null,
    failed,
    errorMessage,
    hasStructuredError,
    unknownSession,
  };
}

// ---------------------------------------------------------------------------
// classification + shared runner
// ---------------------------------------------------------------------------

function classificationSurfaces(stderr, parsed) {
  // Never include model answer text (grok obj.text, codex agent_message, opencode text parts).
  return `${stderr || ''}\n${parsed && parsed.errorMessage ? parsed.errorMessage : ''}`;
}

function hasStructuredError(parsed) {
  return !!(parsed && (parsed.hasStructuredError || parsed.failed));
}

function isFailedRun(exitCode, parsed) {
  return (exitCode != null && exitCode !== 0) || hasStructuredError(parsed);
}

function isUnknownSession(parsed, stderr) {
  if (parsed && parsed.unknownSession) return true;
  return UNKNOWN_SESSION_RE.test(classificationSurfaces(stderr, parsed));
}

function classify({ timedOut, exitCode, stderr, parsed, backend }) {
  if (timedOut) {
    return { class: 'timeout', message: 'backend exceeded --timeout', hint: 'raise --timeout or inspect raw.log' };
  }
  const surfaces = classificationSurfaces(stderr, parsed);
  const failedRun = isFailedRun(exitCode, parsed);
  if (failedRun && QUOTA_RE.test(surfaces)) {
    return { class: 'quota_exceeded', message: parsed && parsed.errorMessage ? parsed.errorMessage : 'quota exceeded', hint: 'add credits or wait for quota reset' };
  }
  if (failedRun && isUnknownSession(parsed, stderr)) {
    return { class: 'backend_failed', message: (parsed && parsed.errorMessage) || 'unknown session', hint: 'omit --session and retry' };
  }
  if (!parsed || parsed.parsed === false) {
    if (failedRun && AUTH_RE.test(surfaces)) {
      return { class: 'auth_required', message: 'authentication required', hint: AUTH_HINT[backend] };
    }
    return { class: 'parse_error', message: (parsed && parsed.errorMessage) || 'unparseable backend output', hint: 'see raw.log' };
  }
  if (failedRun && AUTH_RE.test(surfaces)) {
    return { class: 'auth_required', message: parsed.errorMessage || 'authentication required', hint: AUTH_HINT[backend] };
  }
  if (parsed.failed || (exitCode && exitCode !== 0)) {
    return {
      class: 'backend_failed',
      message: parsed.errorMessage || `backend exited ${exitCode}`,
      hint: 'see stderrTail and raw.log',
    };
  }
  return null;
}

function buildFor(backend, ctx) {
  if (backend === 'grok') return grokBuildArgs(ctx);
  if (backend === 'codex') return codexBuildArgs(ctx);
  if (backend === 'claude') return claudeBuildArgs(ctx);
  return opencodeBuildArgs(ctx);
}

function parseFor(backend, stdout, lastTxtPath) {
  if (backend === 'grok') return grokParse(stdout);
  if (backend === 'codex') return codexParse(stdout, lastTxtPath);
  if (backend === 'claude') return claudeParse(stdout);
  return opencodeParse(stdout);
}

function resolvedModel(backend, model) {
  if (backend === 'grok') return grokResolvedModel(model);
  if (model) return model;
  return null;
}

function writeRunFiles(runDir, { argv, brief, envelope, text }) {
  mkdir0700(runDir);
  fs.writeFileSync(path.join(runDir, 'argv.json'), JSON.stringify(argv, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'stdin.txt'), brief == null ? '' : String(brief));
  fs.writeFileSync(path.join(runDir, 'text.md'), text == null ? '' : String(text));
  fs.writeFileSync(path.join(runDir, 'envelope.json'), JSON.stringify(envelope, null, 2) + '\n');
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const depth = recursionDepth();
  const maxDepth = maxRecursionDepth();
  if (depth >= maxDepth) {
    emit(
      baseEnvelope({
        backend: opts.backend,
        mode: opts.mode,
        model: resolvedModel(opts.backend, opts.model),
        cwd: opts.cwd,
        error: {
          class: 'recursion_guard',
          message: `DELEGATE_DEPTH=${depth} >= DELEGATE_MAX_DEPTH=${maxDepth}; refusing nested delegation`,
          hint: 'unset DELEGATE_DEPTH if you exported it in your shell; raise DELEGATE_MAX_DEPTH to allow one more nested level',
        },
        exitCode: 2,
      }),
      2
    );
  }
  const timeoutSecs =
    opts.timeout != null
      ? opts.timeout
      : Number(process.env.DELEGATE_TIMEOUT_SECS) > 0
        ? Number(process.env.DELEGATE_TIMEOUT_SECS)
        : DEFAULT_TIMEOUT_SECS;
  const timeoutMs = timeoutSecs * 1000;
  const extraArgs = splitShellWords(opts.extraArgsRaw);

  if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
    failUsage('--cwd is not a directory', { backend: opts.backend, mode: opts.mode, cwd: opts.cwd });
  }

  let effectiveCwd = opts.cwd;
  let worktreeInfo = null;
  if (opts.worktreeRequested && !opts.dryRun) {
    const wt = ensureWorktree(opts.cwd, opts.worktreeName);
    if (wt.error) {
      emit(
        baseEnvelope({
          backend: opts.backend,
          mode: opts.mode,
          cwd: opts.cwd,
          model: resolvedModel(opts.backend, opts.model),
          error: wt.error,
          exitCode: 2,
        }),
        2
      );
    }
    worktreeInfo = { path: wt.path, branch: wt.branch, created: wt.created };
    effectiveCwd = wt.path;
  } else if (opts.worktreeRequested && opts.dryRun) {
    effectiveCwd = `${opts.cwd}-wt-${opts.worktreeName}`;
    worktreeInfo = { path: effectiveCwd, branch: `delegate/${opts.worktreeName}`, created: null };
  }

  const bin = findBinary(opts.backend);
  if (!bin) {
    emit(
      baseEnvelope({
        backend: opts.backend,
        mode: opts.mode,
        model: resolvedModel(opts.backend, opts.model),
        cwd: effectiveCwd,
        worktree: worktreeInfo,
        error: {
          class: 'not_installed',
          message: `${opts.backend} CLI not found on PATH or known install locations`,
          hint: INSTALL_HINT[opts.backend],
        },
        exitCode: 2,
      }),
      2
    );
  }

  const pluginData =
    process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'delegate-model');
  const runDir =
    opts.runDir || path.join(pluginData, 'runs', `${nowStamp()}-${opts.backend}-${randHex(3)}`);
  if (!opts.dryRun) mkdir0700(runDir);
  const rawLog = opts.dryRun ? null : path.join(runDir, 'raw.log');
  const lastTxtPath = path.join(runDir, 'last.txt');
  const textFile = path.join(runDir, 'text.md');

  const ctx = {
    brief: opts.brief,
    cwd: effectiveCwd,
    mode: opts.mode,
    model: opts.model,
    session: opts.session,
    extraArgs,
    lastTxtPath,
  };
  let args = buildFor(opts.backend, ctx);
  const command = [bin].concat(args);

  if (opts.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          command,
          cwd: effectiveCwd,
          timeoutSecs,
          mode: opts.mode,
          backend: opts.backend,
          model: resolvedModel(opts.backend, opts.model),
          worktree: worktreeInfo,
        },
        null,
        2
      ) + '\n'
    );
    process.exit(0);
  }

  fs.writeFileSync(path.join(runDir, 'argv.json'), JSON.stringify(command, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'stdin.txt'), opts.brief == null ? '' : String(opts.brief));
  fs.writeFileSync(rawLog, '');

  if (opts.backend === 'opencode') {
    const pre = await preflightOpencode({
      bin,
      cwd: effectiveCwd,
      mode: opts.mode,
      model: opts.model,
      timeoutMs,
    });
    if (pre && pre.error) {
      const env = baseEnvelope({
        backend: opts.backend,
        mode: opts.mode,
        model: resolvedModel(opts.backend, opts.model),
        cwd: effectiveCwd,
        worktree: worktreeInfo,
        command,
        rawLog,
        textFile,
        error: pre.error,
        exitCode: 1,
      });
      writeRunFiles(runDir, { argv: command, brief: opts.brief, envelope: env, text: '' });
      emit(env, 1);
    }
  }

  const started = Date.now();
  let emptyRetried = false;
  let sessionRetried = false;
  let gitStatus = opts.mode === 'write' ? captureGitStatus(effectiveCwd) : null;

  async function once() {
    if (rawLog) fs.appendFileSync(rawLog, `\n--- spawn ${new Date().toISOString()} ---\n`);
    return runCommand({
      bin,
      args,
      cwd: effectiveCwd,
      stdinData: usesStdinBrief(opts.backend) ? ctx.brief : '',
      timeoutMs,
      rawLogPath: rawLog,
    });
  }

  let result = await once();
  let parsed = parseFor(opts.backend, result.stdout, lastTxtPath);

  if (
    opts.session &&
    !result.timedOut &&
    isFailedRun(result.exitCode, parsed) &&
    isUnknownSession(parsed, result.stderr)
  ) {
    sessionRetried = true;
    ctx.session = null;
    args = buildFor(opts.backend, ctx);
    fs.writeFileSync(path.join(runDir, 'argv.json'), JSON.stringify([bin].concat(args), null, 2) + '\n');
    result = await once();
    parsed = parseFor(opts.backend, result.stdout, lastTxtPath);
  }

  if (opts.mode === 'write') gitStatus = captureGitStatus(effectiveCwd);

  const successfulExit = !result.timedOut && result.exitCode === 0;
  if (successfulExit && parsed.parsed && isEmptyText(parsed.text) && !parsed.failed) {
    const dirty = opts.mode === 'write' && gitStatus && gitStatus.trim();
    if (opts.mode === 'read' || (opts.mode === 'write' && !dirty)) {
      emptyRetried = true;
      result = await once();
      parsed = parseFor(opts.backend, result.stdout, lastTxtPath);
      if (opts.mode === 'write') gitStatus = captureGitStatus(effectiveCwd);
    }
  }

  const commandFinal = [bin].concat(args);
  const clipped = clipText(parsed.text || '');
  const durationMs = Date.now() - started;
  let error = classify({
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    stderr: result.stderr,
    parsed,
    backend: opts.backend,
  });

  if (!error && isEmptyText(parsed.text)) {
    error = {
      class: 'empty_final_message',
      message: 'backend exited successfully but final text was empty',
      hint: opts.mode === 'write' ? 'check gitStatus; a dirty tree means work happened' : 'retry with a shorter brief',
    };
  }

  const ok = !error && !result.timedOut && result.exitCode === 0 && !isEmptyText(parsed.text);
  const envelope = baseEnvelope({
    ok,
    backend: opts.backend,
    mode: opts.mode,
    model: resolvedModel(opts.backend, opts.model),
    cwd: effectiveCwd,
    worktree: worktreeInfo,
    command: commandFinal,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    text: clipped.text,
    textTruncated: clipped.truncated,
    textFile,
    sessionId: parsed.sessionId || null,
    usage: parsed.usage || null,
    costUsd: parsed.costUsd,
    emptyRetried,
    sessionRetried,
    gitStatus,
    stderrTail: tailLines(result.stderr, 40),
    rawLog,
    error,
  });
  writeRunFiles(runDir, { argv: commandFinal, brief: opts.brief, envelope, text: parsed.text || '' });

  let code = 0;
  if (!ok) {
    code = error && (error.class === 'usage' || error.class === 'not_installed') ? 2 : 1;
  }
  emit(envelope, code);
}

main().catch((err) => {
  emit(
    baseEnvelope({
      error: { class: 'backend_failed', message: String(err && err.stack ? err.stack : err), hint: 'wrapper crashed' },
      exitCode: 1,
    }),
    1
  );
});
