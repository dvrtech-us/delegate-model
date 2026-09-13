#!/usr/bin/env node
'use strict';

/**
 * ACP v1 client — sibling launch file to delegate.js.
 * Node >= 18, zero dependencies. One JSON envelope on stdout.
 *
 * node acp.js --mode read|write --cwd /abs --agent "cmd [args…]" [options] [-- brief]
 */

const lib = require('./lib');
const {
  spawn,
  fs,
  path,
  KILL_GRACE_MS,
  HANDSHAKE_TIMEOUT_MS,
  AUTH_RE,
  QUOTA_RE,
  UNKNOWN_SESSION_RE,
  PLUGIN_VERSION,
  childEnv,
  findBinary,
  splitShellWords,
  clipText,
  tailLines,
  isEmptyText,
  mkdir0700,
  emit,
  baseEnvelope,
  failUsage,
  takeValue,
  captureGitStatus,
  setActiveChild,
  getActiveChild,
  appendRaw,
  writeRunFiles,
  defaultRunDir,
  resolveTimeoutSecs,
  refuseIfNested,
  prepareCwd,
  waitForChildExit,
  randHex,
} = lib;

const ACP_READ_PREFIX =
  '[READ-ONLY] Do not edit, write, create, or delete files. Do not run commands that change state. Answer from inspection only.\n\n';

lib.setUsageText(() =>
  [
    'Usage: acp.js --mode read|write --cwd /abs --agent "cmd [args…]" [options] [-- brief]',
    'Options: --session ID --worktree [NAME] --timeout SECS --brief-file PATH',
    '         --extra-args "…" --dry-run --run-dir PATH',
    'Model selection belongs in --agent / --extra-args, not --model.',
  ].join('\n')
);

function parseAcpCli(argv) {
  const opts = {
    backend: 'acp',
    mode: null,
    cwd: null,
    agentRaw: '',
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
  if (!args.length) failUsage('missing --mode/--cwd/--agent', { backend: 'acp' });
  if (args[0] === '-h' || args[0] === '--help') failUsage('help', { backend: 'acp' });

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
      '--agent': 'agentRaw',
      '--session': 'session',
      '--timeout': 'timeout',
      '--brief-file': 'briefFile',
      '--extra-args': 'extraArgsRaw',
      '--run-dir': 'runDir',
    };
    if (named[key]) {
      const got = takeValue(args, i, eqVal);
      if (got.missing || got.value == null) failUsage(`${key} requires a value`, { backend: 'acp' });
      i = got.next;
      const field = named[key];
      if (field === 'timeout') {
        const n = Number(got.value);
        if (!Number.isFinite(n) || n <= 0) failUsage('--timeout must be a positive number of seconds', { backend: 'acp' });
        opts.timeout = n;
      } else {
        opts[field] = got.value;
      }
      continue;
    }
    if (a === '--model') {
      failUsage('--model is not supported on acp.js; pass the model in --agent or --extra-args', { backend: 'acp' });
    }
    if (a.startsWith('-')) failUsage(`unknown option: ${a}`, { backend: 'acp' });
    positional.push(a);
  }

  if (opts.briefFile && (opts.brief || positional.length)) {
    failUsage('--brief-file cannot be combined with a trailing/positional brief; pass only one', { backend: 'acp' });
  }
  if (opts.briefFile) {
    try {
      opts.brief = fs.readFileSync(opts.briefFile, 'utf8');
    } catch (err) {
      failUsage(`cannot read --brief-file: ${err.message}`, { backend: 'acp' });
    }
  } else if (!opts.brief && positional.length) {
    opts.brief = positional.join(' ');
  }

  if (!opts.mode || (opts.mode !== 'read' && opts.mode !== 'write')) {
    failUsage('--mode read|write is required', { backend: 'acp', mode: opts.mode });
  }
  if (!opts.cwd) failUsage('--cwd /abs is required', { backend: 'acp', mode: opts.mode });
  if (!path.isAbsolute(opts.cwd)) {
    failUsage('--cwd must be an absolute path', { backend: 'acp', mode: opts.mode, cwd: opts.cwd });
  }
  if (!opts.agentRaw || !String(opts.agentRaw).trim()) {
    failUsage('--agent "cmd [args…]" is required', { backend: 'acp', mode: opts.mode, cwd: opts.cwd });
  }
  if (opts.worktreeRequested) {
    if (!opts.worktreeName || /[\\/]/.test(opts.worktreeName) || opts.worktreeName === '..') {
      failUsage('--worktree name must be a single path segment', { backend: 'acp', mode: opts.mode, cwd: opts.cwd });
    }
  }
  return opts;
}

function pickPermission(mode, options) {
  const list = Array.isArray(options) ? options : [];
  const prefer = mode === 'write' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of prefer) {
    const opt = list.find((o) => o && o.kind === kind && o.optionId);
    if (opt) return { outcome: { outcome: 'selected', optionId: String(opt.optionId) } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

function chunkText(update) {
  if (!update || typeof update !== 'object') return '';
  const content = update.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.type === 'text' && content.text != null) return String(content.text);
  return '';
}

function classifyAcp({ timedOut, stderr, errorMessage, stopReason }) {
  if (timedOut) {
    return { class: 'timeout', message: 'backend exceeded --timeout', hint: 'raise --timeout or inspect raw.log' };
  }
  const surfaces = `${stderr || ''}\n${errorMessage || ''}`;
  if (QUOTA_RE.test(surfaces)) {
    return { class: 'quota_exceeded', message: errorMessage || 'quota exceeded', hint: 'add credits or wait for quota reset' };
  }
  if (AUTH_RE.test(surfaces)) {
    return { class: 'auth_required', message: errorMessage || 'authentication required', hint: 'authenticate the ACP agent CLI, then retry' };
  }
  if (stopReason && stopReason !== 'end_turn') {
    return { class: 'backend_failed', message: errorMessage || `stopReason=${stopReason}`, hint: 'see stderrTail and raw.log' };
  }
  if (errorMessage) {
    return { class: 'backend_failed', message: errorMessage, hint: 'see stderrTail and raw.log' };
  }
  return null;
}

function createRpc(child, rawLog) {
  let nextId = 1;
  const pending = new Map();
  let buf = '';
  let closed = false;
  let stderr = '';
  let onNotification = () => {};
  let onRequest = () => {};
  const MAX_LINE = 8 * 1024 * 1024;

  function settleAll(err) {
    if (closed) return;
    closed = true;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  function handleLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      appendRaw(rawLog, 'stdout-nonjson', t + '\n');
      return;
    }
    appendRaw(rawLog, 'stdout', t + '\n');
    if (msg && typeof msg === 'object' && msg.method && msg.id !== undefined && msg.result === undefined && msg.error === undefined) {
      onRequest(msg);
      return;
    }
    if (msg && typeof msg === 'object' && msg.method && msg.id === undefined) {
      onNotification(msg);
      return;
    }
    if (msg && typeof msg === 'object' && msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rpcError: msg.error }));
      else p.resolve(msg.result);
    }
  }

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > MAX_LINE) {
      settleAll(new Error('ACP stdout line exceeded 8MiB'));
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    stderr += s;
    appendRaw(rawLog, 'stderr', s);
  });
  child.stdin.on('error', () => {
    /* EPIPE after child death */
  });
  child.on('error', (err) => settleAll(err));
  child.on('close', (code, signal) => {
    if (buf.trim()) handleLine(buf);
    buf = '';
    settleAll(new Error(`ACP agent exited (${code == null ? signal : code}) before the RPC completed`));
  });

  function send(obj) {
    if (closed) throw new Error('ACP agent is gone');
    const line = JSON.stringify(obj) + '\n';
    appendRaw(rawLog, 'stdin', line);
    child.stdin.write(line);
  }

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new Error(`ACP RPC timed out: ${method}`));
            }
          }, timeoutMs)
        : null;
      pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      try {
        send({ jsonrpc: '2.0', id, method, params: params || {} });
      } catch (err) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params: params || {} });
  }

  function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  return {
    request,
    notify,
    respond,
    getStderr: () => stderr,
    setOnNotification: (fn) => {
      onNotification = fn;
    },
    setOnRequest: (fn) => {
      onRequest = fn;
    },
    settleAll,
  };
}

async function runAcpOnce({ bin, args, cwd, brief, mode, session, timeoutMs, rawLog }) {
  const started = Date.now();
  let timedOut = false;
  let child;
  try {
    child = spawn(bin, args, {
      cwd: cwd || undefined,
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (err) {
    return {
      okRpc: false,
      timedOut: false,
      exitCode: 1,
      durationMs: Date.now() - started,
      text: '',
      sessionId: null,
      usage: null,
      costUsd: null,
      stopReason: null,
      errorMessage: String(err.message || err),
      stderr: String(err.message || err),
      permissionDenied: false,
    };
  }
  setActiveChild(child);

  const rpc = createRpc(child, rawLog);
  let sessionId = null;
  let textParts = [];
  let collecting = false;
  let usage = null;
  let costUsd = null;
  let permissionDenied = false;
  let timeoutTimer = null;
  let sigkillTimer = null;

  rpc.setOnNotification((msg) => {
    if (msg.method !== 'session/update') return;
    const update = msg.params && msg.params.update;
    if (!update || typeof update !== 'object') return;
    if (!collecting) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      textParts.push(chunkText(update));
    }
    if (update.sessionUpdate === 'usage_update') {
      usage = {
        used: update.used,
        size: update.size,
      };
      if (update.cost && update.cost.currency === 'USD' && typeof update.cost.amount === 'number') {
        costUsd = update.cost.amount;
      }
    }
  });

  rpc.setOnRequest((msg) => {
    if (msg.method === 'session/request_permission') {
      const options = (msg.params && msg.params.options) || [];
      const result = pickPermission(mode, options);
      if (mode === 'read' && result.outcome && result.outcome.outcome === 'selected') {
        const kind = (options.find((o) => o.optionId === result.outcome.optionId) || {}).kind;
        if (kind === 'reject_once' || kind === 'reject_always') permissionDenied = true;
      }
      try {
        rpc.respond(msg.id, result);
      } catch {
        /* child gone */
      }
      return;
    }
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        }) + '\n'
      );
    } catch {
      /* ignore */
    }
  });

  const armTimeout = () => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (sessionId) rpc.notify('session/cancel', { sessionId });
      } catch {
        /* ignore */
      }
      waitForChildExit(child, KILL_GRACE_MS).then(() => {});
    }, timeoutMs);
  };
  armTimeout();

  const finishKill = async () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    await waitForChildExit(child, KILL_GRACE_MS);
    if (getActiveChild() === child) setActiveChild(null);
  };

  try {
    const init = await rpc.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'delegate-model', title: 'Delegate Model', version: PLUGIN_VERSION },
      },
      Math.min(HANDSHAKE_TIMEOUT_MS, timeoutMs)
    );
    const caps = (init && init.agentCapabilities) || {};

    if (session && caps.loadSession) {
      try {
        const loaded = await rpc.request('session/load', { sessionId: session, cwd, mcpServers: [] }, Math.min(HANDSHAKE_TIMEOUT_MS, timeoutMs));
        sessionId = (loaded && loaded.sessionId) || session;
      } catch (err) {
        const msg = String(err.message || err);
        const code = err.rpcError && err.rpcError.code;
        const unknown = code === -32602 || UNKNOWN_SESSION_RE.test(msg);
        if (!unknown) throw err;
        const created = await rpc.request('session/new', { cwd, mcpServers: [] }, Math.min(HANDSHAKE_TIMEOUT_MS, timeoutMs));
        sessionId = created && created.sessionId;
        return Object.assign(await promptTurn(), { sessionRetried: true });
      }
    } else {
      const created = await rpc.request('session/new', { cwd, mcpServers: [] }, Math.min(HANDSHAKE_TIMEOUT_MS, timeoutMs));
      sessionId = created && created.sessionId;
    }
    if (!sessionId) throw new Error('session/new did not return sessionId');

    return await promptTurn();
  } catch (err) {
    const errorMessage = String(err.message || err);
    await finishKill();
    return {
      okRpc: false,
      timedOut,
      exitCode: timedOut ? 1 : child.exitCode == null ? 1 : child.exitCode,
      durationMs: Date.now() - started,
      text: '',
      sessionId,
      usage,
      costUsd,
      stopReason: timedOut ? 'cancelled' : null,
      errorMessage,
      stderr: rpc.getStderr(),
      permissionDenied,
      sessionRetried: false,
    };
  }

  async function promptTurn() {
    collecting = true;
    textParts = [];
    const promptText = mode === 'read' ? ACP_READ_PREFIX + brief : brief;
    const result = await rpc.request(
      'session/prompt',
      {
        sessionId,
        prompt: [{ type: 'text', text: promptText }],
      },
      timeoutMs
    );
    collecting = false;
    const stopReason = result && result.stopReason;
    await finishKill();
    return {
      okRpc: true,
      timedOut,
      exitCode: timedOut ? 1 : 0,
      durationMs: Date.now() - started,
      text: textParts.join(''),
      sessionId,
      usage,
      costUsd,
      stopReason: stopReason || null,
      errorMessage: null,
      stderr: rpc.getStderr(),
      permissionDenied,
      sessionRetried: false,
    };
  }
}

async function main() {
  const opts = parseAcpCli(process.argv.slice(2));
  refuseIfNested({ backend: 'acp', mode: opts.mode, cwd: opts.cwd });
  const timeoutSecs = resolveTimeoutSecs(opts.timeout);
  const timeoutMs = timeoutSecs * 1000;
  const extraArgs = splitShellWords(opts.extraArgsRaw);
  const agentWords = splitShellWords(opts.agentRaw).concat(extraArgs);
  if (!agentWords.length) failUsage('--agent "cmd [args…]" is required', { backend: 'acp', mode: opts.mode, cwd: opts.cwd });

  const { effectiveCwd, worktreeInfo } = prepareCwd(opts, { backend: 'acp', mode: opts.mode });

  const binName = agentWords[0];
  const bin = findBinary(binName);
  if (!bin) {
    emit(
      baseEnvelope({
        backend: 'acp',
        mode: opts.mode,
        cwd: effectiveCwd,
        worktree: worktreeInfo,
        error: {
          class: 'not_installed',
          message: `ACP agent binary not found: ${binName}`,
          hint: 'install the agent CLI and pass a resolvable --agent command',
        },
        exitCode: 2,
      }),
      2
    );
  }
  const args = agentWords.slice(1);
  const command = [bin].concat(args);

  if (opts.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          command,
          cwd: effectiveCwd,
          timeoutSecs,
          mode: opts.mode,
          backend: 'acp',
          model: null,
          worktree: worktreeInfo,
          agent: opts.agentRaw,
        },
        null,
        2
      ) + '\n'
    );
    process.exit(0);
  }

  const runDir = defaultRunDir('acp', opts.runDir);
  mkdir0700(runDir);
  const rawLog = path.join(runDir, 'raw.log');
  const textFile = path.join(runDir, 'text.md');
  fs.writeFileSync(path.join(runDir, 'argv.json'), JSON.stringify(command, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'stdin.txt'), opts.brief == null ? '' : String(opts.brief));
  fs.writeFileSync(rawLog, '');

  const gitBefore = captureGitStatus(effectiveCwd);
  const started = Date.now();
  let sessionRetried = false;
  let emptyRetried = false;

  let result = await runAcpOnce({
    bin,
    args,
    cwd: effectiveCwd,
    brief: opts.brief,
    mode: opts.mode,
    session: opts.session,
    timeoutMs,
    rawLog,
  });
  sessionRetried = !!result.sessionRetried;

  if (opts.session && result.errorMessage && UNKNOWN_SESSION_RE.test(result.errorMessage) && !sessionRetried) {
    sessionRetried = true;
    result = await runAcpOnce({
      bin,
      args,
      cwd: effectiveCwd,
      brief: opts.brief,
      mode: opts.mode,
      session: null,
      timeoutMs,
      rawLog,
    });
  }

  if (!result.timedOut && result.okRpc && isEmptyText(result.text) && !result.permissionDenied) {
    const gitNow = captureGitStatus(effectiveCwd);
    const dirty = gitNow && gitNow.trim();
    if (opts.mode === 'read' || (opts.mode === 'write' && !dirty)) {
      emptyRetried = true;
      result = await runAcpOnce({
        bin,
        args,
        cwd: effectiveCwd,
        brief: opts.brief,
        mode: opts.mode,
        session: null,
        timeoutMs,
        rawLog,
      });
    }
  }

  const gitAfter = captureGitStatus(effectiveCwd);
  let error = classifyAcp({
    timedOut: result.timedOut,
    stderr: result.stderr,
    errorMessage: result.errorMessage,
    stopReason: result.stopReason,
  });

  if (!error && opts.mode === 'read' && gitAfter && gitAfter.trim() && gitAfter !== gitBefore) {
    error = {
      class: 'read_mode_violated',
      message: 'ACP agent modified the worktree in --mode read',
      hint: 'pass the agent\'s own read-only/plan flag in --agent; permission rejects are not a sandbox',
    };
  }

  if (!error && result.permissionDenied && isEmptyText(result.text) && result.stopReason && result.stopReason !== 'end_turn') {
    error = {
      class: 'permission_denied',
      message: 'ACP agent stopped after a read-mode permission reject',
      hint: 'this is expected for write tools in --mode read',
    };
  }

  if (!error && isEmptyText(result.text)) {
    error = {
      class: 'empty_final_message',
      message: 'backend exited successfully but final text was empty',
      hint: opts.mode === 'write' ? 'check gitStatus; a dirty tree means work happened' : 'retry with a shorter brief',
    };
  }

  const clipped = clipText(result.text || '');
  const ok = !error && !result.timedOut && result.okRpc && !isEmptyText(result.text);
  const envelope = baseEnvelope({
    ok,
    backend: 'acp',
    mode: opts.mode,
    model: null,
    cwd: effectiveCwd,
    worktree: worktreeInfo,
    command,
    exitCode: result.exitCode,
    timedOut: !!result.timedOut,
    durationMs: Date.now() - started,
    text: clipped.text,
    textTruncated: clipped.truncated,
    textFile,
    sessionId: result.sessionId || null,
    usage: result.usage || null,
    costUsd: result.costUsd,
    emptyRetried,
    sessionRetried,
    gitStatus: gitAfter,
    stderrTail: tailLines(result.stderr, 40),
    rawLog,
    error,
  });
  writeRunFiles(runDir, { argv: command, brief: opts.brief, envelope, text: result.text || '' });
  let code = 0;
  if (!ok) {
    code = error && (error.class === 'usage' || error.class === 'not_installed') ? 2 : 1;
  }
  emit(envelope, code);
}

main().catch((err) => {
  emit(
    baseEnvelope({
      backend: 'acp',
      error: { class: 'backend_failed', message: String(err && err.stack ? err.stack : err), hint: 'acp.js crashed' },
      exitCode: 1,
    }),
    1
  );
});
