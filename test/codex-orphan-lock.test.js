'use strict';
// Codex's thread-writer lock is an empty file with no PID, so mtime cannot tell
// a live holder from the corpse of a crash. These tests pin the three probe
// states against a stubbed process list and a stubbed `run`, inside a throwaway
// CODEX home: the real ~/.codex is never read or written, and no codex process
// is launched or touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stubModule(relativeId, exports) {
  const id = require.resolve(relativeId);
  const previous = Object.prototype.hasOwnProperty.call(require.cache, id) ? require.cache[id] : undefined;
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
  return () => { if (previous) require.cache[id] = previous; else delete require.cache[id]; };
}

const LOCKED_STDERR = 'Error: thread-store conflict: thread already has an active writer';

// A temporary CODEX home holding one session rollout and one orphan-looking lock.
function useTempCodexHome(sessionId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-codexhome-'));
  const sessions = path.join(home, '.codex', 'sessions', '2026');
  const locks = path.join(home, '.codex', 'thread-writer-locks');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const file = path.join(sessions, `rollout-2026-01-01-${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: home } })}\n`);
  const lock = path.join(locks, `${sessionId}.lock`);
  fs.writeFileSync(lock, '');   // exactly what Codex leaves behind: nothing but a name
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home, file, lock,
    restore() {
      Object.assign(process.env, env);
      const id = require.resolve('../lib/adapters/codex.js');
      if (require.cache[id]) delete require.cache[id];
    },
  };
}

// Loads the adapter with `run` replaced by a script of codex outcomes.
function useStubbedRun(outcomes) {
  const calls = [];
  const queue = [...outcomes];
  const restore = stubModule('../lib/util', {
    run: (command, argv, options) => {
      calls.push({ command, argv, options });
      const next = queue.shift();
      if (!next) throw new Error('the stub ran out of codex outcomes');
      return next;
    },
    resolveZcodeCli: () => null,
    zcodeConfigPath: () => path.join(os.tmpdir(), 'unused'),
  });
  const id = require.resolve('../lib/adapters/codex.js');
  delete require.cache[id];
  return { calls, codex: require(id), restore };
}

function captureStderr() {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  return { written, text: () => written.join(''), restore: () => { process.stderr.write = original; } };
}

const SESSION = '0198ca7a-1111-4222-8888-abcdefabcdef';

test('the holder probe reads the process list through argv and answers all three states', () => {
  const { codex } = useStubbedRun([]);
  const spawns = [];
  const fake = (result) => (command, argv, options) => {
    spawns.push({ command, argv, options });
    if (result instanceof Error) throw result;
    return result;
  };

  // A live codex.exe (the Boss's PID 76768 case) is reported with its pid, and
  // the other Codex-named processes are named too so a human can see the whole
  // picture the verdict was taken from.
  assert.deepEqual(
    codex.probeCodexHolder({
      platform: 'win32',
      spawn: fake({ status: 0, stdout: '"chrome.exe","1000","Console","1","100 K"\r\n"codex-windows-sandbox-service.exe","78008","Services","0","200 K"\r\n"codex.exe","76768","Console","1","300 K"\r\n', stderr: '' }),
    }),
    {
      state: 'alive',
      detail: 'codex.exe pid 76768 (also running, not a writer candidate: codex-windows-sandbox-service.exe)',
      processes: [{ name: 'codex.exe', pid: '76768' }],
      family: [{ name: 'codex-windows-sandbox-service.exe', pid: '78008' }, { name: 'codex.exe', pid: '76768' }],
    },
  );
  // The installed sandbox service outlives every session, so it alone must not
  // read as a holder - otherwise the crash case has no exit again.
  const serviceOnly = codex.probeCodexHolder({
    platform: 'win32',
    spawn: fake({ status: 0, stdout: '"codex-windows-sandbox-service.exe","78008","Services","0","200 K"\r\n"codex-computer-use-swift.exe","33268","Console","1","100 K"\r\n', stderr: '' }),
  });
  assert.equal(serviceOnly.state, 'orphan');
  assert.match(serviceOnly.detail, /no codex\.exe running/);
  assert.match(serviceOnly.detail, /codex-windows-sandbox-service\.exe pid 78008/, 'the leftovers are still named, not hidden');
  assert.equal(serviceOnly.family.length, 2);
  // tasklist's own prose (in any locale) is not a process row: that is the orphan
  // answer, and it is only trusted because nothing named codex* appeared.
  assert.equal(codex.probeCodexHolder({ platform: 'win32', spawn: fake({ status: 0, stdout: 'INFO: No tasks are running which match the specified criteria.\r\n', stderr: '' }) }).state, 'orphan');
  const nothing = codex.probeCodexHolder({ platform: 'win32', spawn: fake({ status: 0, stdout: '"chrome.exe","1000","Console","1","100 K"\r\n', stderr: '' }) });
  assert.equal(nothing.state, 'orphan');
  assert.equal(nothing.detail, 'no Codex process of any name is running');
  assert.deepEqual(spawns.map((s) => s.argv), [['/FO', 'CSV', '/NH'], ['/FO', 'CSV', '/NH'], ['/FO', 'CSV', '/NH'], ['/FO', 'CSV', '/NH']], 'one listing per probe, no image-name filter');
  assert.deepEqual([...new Set(spawns.map((s) => s.options.shell))], [false], 'the process name never goes through a shell');
  // A probe that cannot answer is not an orphan.
  assert.equal(codex.probeCodexHolder({ platform: 'win32', spawn: fake({ status: 1, stdout: '', stderr: 'access denied' }) }).state, 'unknown');
  assert.equal(codex.probeCodexHolder({ platform: 'win32', spawn: fake({ error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), status: null, stdout: '', stderr: '' }) }).state, 'unknown');
  assert.match(codex.probeCodexHolder({ platform: 'win32', spawn: fake({ error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), status: null }) }).detail, /ENOENT/);
  assert.equal(codex.probeCodexHolder({ platform: 'win32', spawn: fake(new Error('boom')) }).state, 'unknown', 'a throwing probe is still not a pass');
});

test('off Windows the probe abstains and never spawns anything', () => {
  const { codex } = useStubbedRun([]);
  const spawns = [];
  const outcome = codex.probeCodexHolder({ platform: 'linux', spawn: () => { spawns.push(1); return { status: 0, stdout: '' }; } });
  assert.equal(outcome.state, 'unknown');
  assert.match(outcome.detail, /only implemented for Windows/);
  assert.deepEqual(spawns, [], 'no guessing about lock semantics nobody measured');
});

test('a live holder keeps the single-writer refusal and costs no second attempt', () => {
  const temp = useTempCodexHome(SESSION);
  const stub = useStubbedRun([{ status: 1, stdout: '', stderr: LOCKED_STDERR }]);
  const stderr = captureStderr();
  try {
    const probe = () => ({ state: 'alive', detail: 'codex.exe pid 76768' });
    assert.throws(() => stub.codex.send(SESSION, 'hello', { holderProbe: probe, platform: 'win32' }), (error) => {
      assert.match(error.message, /open in another Codex instance/);
      assert.match(error.message, /codex\.exe pid 76768/, 'the refusal says who holds it');
      assert.match(error.message, /read_session still works/);
      assert.equal(error.orphanLock, undefined, 'nothing orphaned here');
      return true;
    });
    assert.equal(stub.calls.length, 1, 'a live holder must not be retried against');
    assert.equal(stderr.text(), '', 'no orphan warning on the honest refusal path');
    assert.equal(fs.existsSync(temp.lock), true, 'the lock is Codex state; this adapter does not delete it');
  } finally {
    stderr.restore(); stub.restore(); temp.restore();
  }
});

test('a failed probe is treated as a live holder (fail closed)', () => {
  const temp = useTempCodexHome(SESSION);
  const stub = useStubbedRun([{ status: 1, stdout: '', stderr: LOCKED_STDERR }]);
  try {
    const probe = () => ({ state: 'unknown', detail: 'tasklist could not run: ENOENT' });
    assert.throws(() => stub.codex.send(SESSION, 'hello', { holderProbe: probe, platform: 'win32' }), (error) => {
      assert.match(error.message, /could not answer \(tasklist could not run: ENOENT\)/);
      assert.match(error.message, /treated as live/);
      return true;
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(fs.existsSync(temp.lock), true);
  } finally { stub.restore(); temp.restore(); }
});

// An orphaned lock changes the WORDING of the refusal, never the outcome: nothing
// is injected, nothing is retried, and Codex's own lock file is left alone.
test('an orphaned lock is explained as such and never injected past', () => {
  const temp = useTempCodexHome(SESSION);
  const stub = useStubbedRun([{ status: 1, stdout: '', stderr: LOCKED_STDERR }]);
  const stderr = captureStderr();
  try {
    const probe = () => ({ state: 'orphan', detail: 'no codex.exe running', processes: [] });
    assert.throws(() => stub.codex.send(SESSION, 'hello', { holderProbe: probe, platform: 'win32' }), (error) => {
      assert.equal(error.orphanLock, true, 'the caller can tell an orphan from a live holder');
      assert.equal(error.uncertain, false, 'nothing was typed, so there is nothing uncertain');
      assert.equal(error.holder, 'no codex.exe running');
      assert.match(error.message, /lock holder not running/);
      assert.match(error.message, new RegExp(`empty file with no PID \\(${temp.lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), 'it says what cannot be known from the lock itself');
      assert.match(error.message, /check the process list shows no codex\.exe/, 'and how to confirm');
      assert.match(error.message, /delete that lock file yourself/, 'and how to clear it');
      assert.match(error.message, /will not delete it or inject past it/, 'and what this tool refuses to do');
      assert.match(error.message, /read_session still works/);
      return true;
    });
    assert.equal(stub.calls.length, 1, 'no delivery attempt is made behind the lock');
    assert.equal(stderr.text(), '', 'the refusal is the signal; it is not also a warning line');
    assert.equal(fs.existsSync(temp.lock), true, 'the lock file is Codex state and stays put');
  } finally {
    stderr.restore(); stub.restore(); temp.restore();
  }
});

test('an unrelated codex failure never reaches the lock logic', () => {
  const temp = useTempCodexHome(SESSION);
  const stub = useStubbedRun([{ status: 2, stdout: '', stderr: 'model provider returned 401' }]);
  let probed = 0;
  try {
    assert.throws(() => stub.codex.send(SESSION, 'hello', { holderProbe: () => { probed += 1; return { state: 'orphan', detail: 'x' }; }, platform: 'win32' }), (error) => {
      assert.match(error.message, /codex exited 2: model provider returned 401/);
      return true;
    });
    assert.equal(probed, 0, 'the probe is for lock refusals only');
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); temp.restore(); }
});

test('the lock age is reported only when the lock really is there', () => {
  const temp = useTempCodexHome(SESSION);
  const stub = useStubbedRun([
    { status: 1, stdout: '', stderr: LOCKED_STDERR },
    { status: 1, stdout: '', stderr: LOCKED_STDERR },
  ]);
  try {
    const probe = () => ({ state: 'alive', detail: 'codex.exe pid 1' });
    assert.throws(() => stub.codex.send(SESSION, 'hello', { holderProbe: probe, platform: 'win32' }), /lock last touched \d+m ago/);
    fs.rmSync(temp.lock);
    assert.throws(() => stub.codex.send(SESSION, 'hello', { holderProbe: probe, platform: 'win32' }), (error) => {
      assert.doesNotMatch(error.message, /lock last touched/, 'a guessed path is not stated as fact');
      return true;
    });
  } finally { stub.restore(); temp.restore(); }
});
