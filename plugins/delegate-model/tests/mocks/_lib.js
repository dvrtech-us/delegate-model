'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function markSpawned() {
  const p = process.env.MOCK_SPAWN_MARKER;
  if (p) fs.writeFileSync(p, String(process.pid));
}

function writePid() {
  const p = process.env.MOCK_PID_FILE;
  if (p) fs.writeFileSync(p, String(process.pid));
}

function stateFile() {
  return process.env.MOCK_STATE_FILE || path.join(os.tmpdir(), 'delegate-mock-empty-state');
}

function consumeEmptyThenOk() {
  const f = stateFile();
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, '1');
    return 'empty';
  }
  try {
    fs.unlinkSync(f);
  } catch {
    /* ignore */
  }
  return 'ok';
}

function cwdFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--cwd' || args[i] === '-C' || args[i] === '--dir' || args[i] === '--cd') && args[i + 1]) {
      return args[i + 1];
    }
  }
  return process.cwd();
}

function lastOutPath(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-o' || args[i] === '--output-last-message') && args[i + 1]) return args[i + 1];
  }
  return null;
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function touchInCwd(args) {
  const dir = cwdFromArgs(args);
  fs.writeFileSync(path.join(dir, 'delegate-touched.txt'), 'touched\n');
}

function hang() {
  writePid();
  setInterval(() => {}, 1 << 30);
}

function behavior() {
  return process.env.MOCK_BEHAVIOR || 'ok';
}

function resolveBehavior() {
  const b = behavior();
  if (b === 'empty_then_ok') return consumeEmptyThenOk();
  return b;
}

module.exports = {
  fs,
  path,
  FIXTURES,
  markSpawned,
  writePid,
  cwdFromArgs,
  lastOutPath,
  readFixture,
  touchInCwd,
  hang,
  resolveBehavior,
};
