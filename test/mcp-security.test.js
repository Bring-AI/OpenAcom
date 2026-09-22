'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

// Everything this file touches is redirected into a throwaway AGENTRELAY_HOME so
// the real ~/.openacom (log file, inbox store, web token) is never written to.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-sec-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.AGENTRELAY_WEB_TOKEN;
delete process.env.AGENTRELAY_URL;
delete process.env.AGENTRELAY_TOKEN;

const mcp = require('../lib/mcp');
const inbox = require('../lib/inbox');
const web = require('../lib/web');

const POSIX = process.platform !== 'win32';
const modeOf = (p) => fs.statSync(p).mode & 0o777;

function readLog() {
  const f = path.join(mcp.traceDir(), mcp.TRACE_FILE);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

// Run the callback as if on Linux and record every chmod the production code
// asks for, so the POSIX-only hardening branches are exercised on a Windows
// runner too. Filesystem-mode assertions stay gated on the real platform
// (POSIX below is captured before any override).
function watchChmod(fn) {
  const real = fs.chmodSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const seen = [];
  fs.chmodSync = (p, mode) => { seen.push([String(p), mode]); return real(p, mode); };
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' });
  const restore = () => { fs.chmodSync = real; Object.defineProperty(process, 'platform', realPlatform); };
  return Promise.resolve(fn(seen)).finally(restore);
}

// ---------------------------------------------------------------- M3: tracing

test('traceCall replaces every body-bearing argument with a length + digest', () => {
  const body = 'SECRET-BODY: const x = 1; C:\\Users\\dev\\internal\\svc.cs 你好';
  mcp.traceCall('relay_send', { to: 'node-a', target: 'coder', text: body }, '{"ok":true}', false);
  mcp.traceCall('send_message', { from: 'zcode:s1', to: 'zcode:s2', message: body }, '{}', false);
  mcp.traceCall('list_sessions', { query: body, limit: 5 }, '[]', false);
  const log = readLog();
  assert.ok(!log.includes('SECRET-BODY'), 'raw body must never reach the log');
  assert.ok(!log.includes('internal'), 'raw path must never reach the log');
  assert.ok(!log.includes('你好'), 'raw unicode body must never reach the log');
  for (const key of ['text', 'message', 'query']) {
    const line = log.split('\n').filter(Boolean).find((l) => l.includes(`"${key}"`));
    assert.ok(line, `a trace line for ${key} exists`);
    const args = JSON.parse(line.slice(line.indexOf('args=') + 5));
    assert.match(args[key], /^len=\d+ sha256:[0-9a-f]{12}$/, `${key} is summarised`);
  }
  // Non-sensitive addressing survives, so the log stays useful.
  const relay = JSON.parse(readLog().split('\n')[0].split('args=')[1]);
  assert.equal(relay.to, 'node-a');
  assert.equal(relay.target, 'coder');
});

test('traceCall byte length counts utf-8 bytes, not code units', () => {
  mcp.traceCall('relay_send', { to: 'n', target: 't', text: '你好' }, '{}', false);
  const last = readLog().trim().split('\n').pop();
  assert.match(last, /"text":"len=6 sha256:[0-9a-f]{12}"/);
});

test('tools/call traces redacted arguments on the error path too', async () => {
  const before = readLog().length;
  const resp = await mcp.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'send_message', arguments: { from: 'bogus', to: 'zcode:s', message: 'PLAINTEXT-MUST-NOT-LEAK' } },
  });
  assert.equal(resp.isError ?? resp.result.isError, true);
  const log = readLog().slice(before);
  assert.ok(log.includes('PLAINTEXT-MUST-NOT-LEAK') === false, 'message text is not traced');
  assert.match(log, /"message":"len=23 sha256:[0-9a-f]{12}"/);
});

test('trace log is protected once per process, its file on creation, and rotates at the cap', () => watchChmod(async (seen) => {
  const dir = mcp.traceDir();
  const file = path.join(dir, mcp.TRACE_FILE);
  const want = (p) => path.normalize(p).replace(/\\/g, '/');
  mcp.traceCall('get_paths', {}, '{}', false);
  assert.equal(typeof mcp.traceAcl(), 'string', 'the acl marker is exposed to callers');
  // The dir was protected by this process' first traced call, and an existing
  // log keeps the access it was created with: no protection per append.
  assert.ok(!seen.some(([p]) => want(p) === want(dir)), 'no repeated dir protection per call');
  assert.ok(!seen.some(([p]) => want(p) === want(file)), 'no chmod on an existing log');

  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 10), { mode: 0o600 });
  mcp.traceCall('get_paths', {}, '{}', false);
  assert.ok(fs.existsSync(`${file}.1`), 'oversized log renamed to .1');
  assert.ok(fs.statSync(file).size < 1024 * 1024, 'log restarted after rotation');
  assert.ok(seen.some(([p, m]) => want(p) === want(file) && m === 0o600), 'a freshly created log is made private');
  if (POSIX) assert.equal(modeOf(dir), 0o700);
}));

// ------------------------------------------------------------------ H4: web

function request(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const close = (server) => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

test('web dashboard issues a 0600 token file, prints it once and guards every /api call', async () => {
  const errLines = [];
  const realErr = console.error;
  console.error = (m) => errLines.push(String(m));
  let server;
  try {
    server = await web.startWeb(0, { open: false });
  } finally {
    console.error = realErr;
  }
  const port = server.address().port;
  const token = fs.readFileSync(web.TOKEN_FILE(), 'utf8').trim();
  try {
    assert.ok(token.length >= 32, 'token generated');
    assert.equal(server.openacomToken, token);
    assert.ok(errLines.some((l) => l.includes(token)), 'token printed to stderr on creation');
    if (POSIX) {
      assert.equal(modeOf(web.TOKEN_FILE()), 0o600);
      assert.equal(modeOf(path.dirname(web.TOKEN_FILE())), 0o700);
    }
    const auth = { 'X-OpenAcom-Token': token };
    const host = { Host: `127.0.0.1:${port}` };

    assert.equal((await request(port, { path: '/api/stats', headers: host })).status, 401, 'no token -> 401');
    assert.equal((await request(port, { path: '/api/stats', headers: { ...host, 'X-OpenAcom-Token': 'wrong' } })).status, 401, 'wrong token -> 401');
    assert.equal((await request(port, { path: '/api/stats', headers: { ...host, 'X-OpenAcom-Token': token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') } })).status, 401, 'same-length wrong token -> 401');
    assert.equal((await request(port, { method: 'POST', path: '/api/ack', headers: { ...host, 'Content-Type': 'application/json' } })).status, 401, 'ack endpoint needs a token');
    const stats = await request(port, { path: '/api/stats', headers: { ...host, ...auth } });
    assert.equal(stats.status, 200);
    assert.deepEqual(JSON.parse(stats.body).read, 0);
    const meta = await request(port, { path: '/api/meta', headers: { ...host, ...auth } });
    assert.equal(meta.status, 200);
    const unknownAck = await request(port, {
      method: 'POST', path: '/api/ack', headers: { ...host, ...auth, 'Content-Type': 'application/json' },
    });
    assert.equal(unknownAck.status, 400, 'a tokened ack of an empty id is rejected, not applied');
  } finally {
    await close(server);
  }
});

test('web dashboard refuses any Host header that is not its own loopback origin', async () => {
  const server = await web.startWeb(0, { open: false, token: 'fixed-test-token-' + 'z'.repeat(20) });
  const port = server.address().port;
  const auth = { 'X-OpenAcom-Token': 'fixed-test-token-' + 'z'.repeat(20) };
  try {
    for (const bad of ['evil.example.com', `attacker.evil:${port}`, '127.0.0.2:' + port, 'localhost:' + (port + 1), '127.0.0.1.evil.com', `[::1]:${port}`]) {
      const r = await request(port, { path: '/api/stats', headers: { Host: bad, ...auth } });
      assert.equal(r.status, 403, `Host "${bad}" refused even with the token`);
    }
    assert.equal(web.hostAllowed('', port), false, 'a missing Host is refused');
    assert.equal(web.hostAllowed(`127.0.0.1:${port}`, port), true);
    assert.equal((await request(port, { path: '/api/stats', headers: { Host: `localhost:${port}`, ...auth } })).status, 200, 'localhost origin allowed');
    assert.equal((await request(port, { path: '/api/stats', headers: { Host: `127.0.0.1:${port}`, ...auth } })).status, 200);
    assert.equal((await request(port, { path: '/', headers: { Host: 'evil.example.com' } })).status, 403, 'page too');
  } finally {
    await close(server);
  }
});

test('web dashboard answers preflight with its own origin and injects the token into the pages', async () => {
  const server = await web.startWeb(0, { open: false, token: 'inject-me-0123456789abcdef' });
  const port = server.address().port;
  try {
    const pre = await request(port, {
      method: 'OPTIONS', path: '/api/messages',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`, 'only our own origin is echoed');
    assert.match(pre.headers['access-control-allow-headers'] || '', /x-openacom-token/i);

    const api = await request(port, { path: '/api/stats', headers: { Host: `127.0.0.1:${port}`, 'X-OpenAcom-Token': 'inject-me-0123456789abcdef' } });
    assert.equal(api.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`);

    for (const page of ['/', '/docs']) {
      const r = await request(port, { path: page, headers: { Host: `127.0.0.1:${port}` } });
      assert.equal(r.status, 200, `${page} served`);
      assert.ok(!r.body.includes('__OA_TOKEN__'), `${page} placeholder replaced`);
      assert.ok(r.body.includes('"inject-me-0123456789abcdef"'), `${page} carries the token for the browser`);
      assert.ok(r.body.includes('X-OpenAcom-Token'), `${page} sends the token on its fetches`);
    }
  } finally {
    await close(server);
  }
});

test('the dashboard page builds URLs the router actually serves', async () => {
  const server = await web.startWeb(0, { open: false, token: 'url-check-token-0123456789ab' });
  const port = server.address().port;
  try {
    const page = await request(port, { path: '/', headers: { Host: `127.0.0.1:${port}` } });
    const arg = page.body.match(/const rows = await api\(([^;]*)\);/)[1];
    const build = new Function('filter', `return (${arg});`);
    assert.equal(build('all'), '/api/messages?limit=200');
    assert.equal(build('sent'), '/api/messages?status=sent&limit=200');
    for (const f of ['all', 'sent', 'read', 'failed', 'pending']) {
      const r = await request(port, {
        path: build(f),
        headers: { Host: `127.0.0.1:${port}`, 'X-OpenAcom-Token': 'url-check-token-0123456789ab' },
      });
      assert.equal(r.status, 200, `${build(f)} is served, not 404`);
      assert.ok(Array.isArray(JSON.parse(r.body)), `${build(f)} returns a row array`);
    }
  } finally {
    await close(server);
  }
});

test('the token statement the pages carry resolves to the served token', () => {
  // Exactly the line both pages ship: safe when the file is opened un-served
  // (no injection), correct once startWeb has substituted the placeholder.
  const line = (served) => `window.__OPENACOM_TOKEN__ = typeof ${served} === 'string' ? ${served} : '';`;
  const run = (src) => {
    const vm = require('node:vm');
    const ctx = vm.createContext({ window: {} });
    vm.runInContext(src, ctx);
    return ctx.window.__OPENACOM_TOKEN__;
  };
  assert.equal(run(line('__OA_TOKEN__')), '', 'un-served page degrades to no token, not a crash');
  assert.equal(run(line(JSON.stringify('a-b-c'))), 'a-b-c', 'served page sees the token');
  assert.equal(run(line(JSON.stringify('</script><img src=x>'))), '</script><img src=x>', 'a hostile env token stays a string literal');
});

test('web token is taken from the environment and never printed when pinned', async () => {
  const errLines = [];
  const realErr = console.error;
  console.error = (m) => errLines.push(String(m));
  process.env.AGENTRELAY_WEB_TOKEN = 'env-pinned-token-0123456789';
  let server;
  try {
    server = await web.startWeb(0, { open: false });
  } finally {
    console.error = realErr;
    delete process.env.AGENTRELAY_WEB_TOKEN;
  }
  const port = server.address().port;
  try {
    const r = await request(port, { path: '/api/stats', headers: { Host: `127.0.0.1:${port}`, 'X-OpenAcom-Token': 'env-pinned-token-0123456789' } });
    assert.equal(r.status, 200);
    assert.equal(errLines.length, 0, 'no token printed when the operator pinned it');
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------- M7: inbox

function fakeAdapter({ autoAck = false, throws = false } = {}) {
  const transcript = [];
  const sent = [];
  return {
    name: 'zcode',
    transcript,
    sent,
    send: async (sessionId, message) => {
      if (throws) throw new Error('delivery exploded');
      sent.push(message);
      // The delivered footer is a user turn - it must never read as a receipt.
      transcript.push({ role: 'user', text: message });
      if (autoAck) {
        const id = (message.match(/ACK-([a-f0-9-]+)/) || [])[1];
        transcript.push({ role: 'assistant', text: `已处理，回执 ACK-${id}` });
      }
      return 'OK sent';
    },
    messages: () => transcript.slice(-8),
  };
}

test('inbox store dir is 0700 and the sqlite file is 0600', () => watchChmod(async (seen) => {
  inbox.close(); // force a real first-open so the permission branch runs
  inbox.create({ fromAddr: 'zcode:a', toAddr: 'zcode:b', agent: 'zcode', sessionId: 'b', text: 'perm probe' });
  const file = inbox.DB_PATH();
  assert.ok(fs.existsSync(file));
  const want = (p) => path.normalize(p).replace(/\\/g, '/');
  assert.ok(seen.some(([p, m]) => want(p) === want(path.dirname(file)) && m === 0o700), 'dir chmod 0700 requested');
  assert.ok(seen.some(([p, m]) => want(p) === want(file) && m === 0o600), 'db chmod 0600 requested');
  if (POSIX) {
    assert.equal(modeOf(path.dirname(file)), 0o700);
    assert.equal(modeOf(file), 0o600);
  }
}));

test('a stale ACK token in the transcript is not an acknowledgment', () => {
  const id = randomUUID();
  const transcript = [
    { role: 'user', text: 'please ACK-' + id },
    { role: 'assistant', text: `好的，收到 ACK-${id}` }, // recited footer, from before this send
  ];
  const a = { name: 'zcode', messages: () => transcript.slice(-8) };
  const baseline = inbox.countAckTurns(a, 'sess', id);
  assert.equal(baseline, 1, 'the pre-existing token turn is measured');
  assert.equal(inbox.ackLanded(a, 'sess', id, baseline), false, 'unchanged history must not read as a receipt');
  transcript.push({ role: 'assistant', text: `又做了一遍 ACK-${id}` });
  assert.equal(inbox.ackLanded(a, 'sess', id, baseline), true, 'a genuinely new assistant turn still acks');
});

test('an unreadable transcript disables the token ack instead of guessing', () => {
  const id = randomUUID();
  const broken = { name: 'zcode', messages: () => { throw new Error('locked'); } };
  assert.equal(inbox.countAckTurns(broken, 's', id), -1);
  assert.equal(inbox.ackLanded(broken, 's', id, -1), false);
  assert.equal(inbox.ackLanded(broken, 's', id, 0), false);
});

test('token that only ever appears in user turns never acks; honest failure after all attempts', async () => {
  const a = fakeAdapter();
  const outcome = await inbox.trackedSend(a, 'sess-1', 'zcode:sender', 'echo the footer back verbatim', {
    ackTimeoutMs: 80, maxAttempts: 2, pollMs: 20,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.attemptsUsed, 2);
  assert.ok(a.transcript.some((t) => t.role === 'user' && /ACK-/.test(t.text)), 'the token was in fact present - as a user turn');
  const row = inbox.get(outcome.id);
  assert.equal(row.status, 'failed');
});

test('a fresh assistant turn carrying the token settles the receipt', async () => {
  const a = fakeAdapter({ autoAck: true });
  const outcome = await inbox.trackedSend(a, 'sess-2', 'zcode:sender', 'please read this', {
    ackTimeoutMs: 500, maxAttempts: 3, pollMs: 20,
  });
  assert.equal(outcome.status, 'read');
  assert.equal(outcome.note, 'acknowledged via reply token');
  assert.equal(outcome.attemptsUsed, 1, 'no redelivery once the receipt lands');
});

test('an explicit ack_message still wins over the transcript scan', async () => {
  const a = fakeAdapter();
  const p = inbox.trackedSend(a, 'sess-3', 'zcode:sender', 'ack me via the tool', {
    ackTimeoutMs: 2000, maxAttempts: 3, pollMs: 20,
  });
  const id = (a.sent[0].match(/ACK-([a-f0-9-]+)/) || [])[1];
  await new Promise((r) => setTimeout(r, 60));
  inbox.markRead(id);
  const outcome = await p;
  assert.equal(outcome.status, 'read');
  assert.match(outcome.note, /ack_message/);
});

test('a delivery failure burns an attempt and reports the problem instead of a read', async () => {
  const a = fakeAdapter({ throws: true });
  const outcome = await inbox.trackedSend(a, 'sess-4', 'zcode:sender', 'undeliverable', {
    ackTimeoutMs: 40, maxAttempts: 2, pollMs: 10,
  });
  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.problems.every((p) => /delivery failed/.test(p)), JSON.stringify(outcome.problems));
});

// ------------------------------------------------------------------ wave 4: ACL

// Reload a module against a recording stand-in for lib/secure-fs. This runner is
// Windows, protectPath memoizes per process, and a real icacls would rewrite the
// throwaway tree's descriptors - a fresh load with a recorder is the only way to
// see exactly which paths one creation protects, and how often.
const pristine = new Map();

function withSecureFsRecorder(modPath, acl = 'private') {
  const secPath = require.resolve('../lib/secure-fs');
  const targetPath = require.resolve(modPath);
  if (!pristine.has(targetPath)) pristine.set(targetPath, require.cache[targetPath]);
  const realSecure = require.cache[secPath];
  const { aggregateAcl, PRIVATE, INHERITED, currentPrincipal } = require('../lib/secure-fs');
  const calls = [];
  require.cache[secPath] = {
    id: secPath, filename: secPath, loaded: true,
    exports: {
      aggregateAcl, PRIVATE, INHERITED, currentPrincipal,
      protectPath: (p, opts = {}) => {
        calls.push({ path: p, directory: !!opts.directory, exists: fs.existsSync(p) });
        return { acl, path: p, platform: 'stub', principal: 'STUB\\user' };
      },
    },
  };
  delete require.cache[targetPath];
  const loaded = require(modPath);
  const restore = () => {
    require.cache[secPath] = realSecure;
    // Back to the instance the file loaded at start-up, never to another probe's.
    require.cache[targetPath] = pristine.get(targetPath);
  };
  return { calls, loaded, restore };
}

async function inFreshHome(sub, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-acl-'));
  const real = process.env.AGENTRELAY_HOME;
  process.env.AGENTRELAY_HOME = path.join(root, sub);
  try { return await run(root); } finally {
    if (real === undefined) delete process.env.AGENTRELAY_HOME;
    else process.env.AGENTRELAY_HOME = real;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}

test('token creation protects the home dir and the token file, exactly once each', () => inFreshHome('web', () => {
  const probe = withSecureFsRecorder('../lib/web');
  try {
    const out = probe.loaded.loadToken();
    assert.equal(out.created, true, 'a token was created');
    assert.equal(out.acl, 'private');
    const dir = path.dirname(probe.loaded.TOKEN_FILE());
    assert.deepEqual(probe.calls, [
      { path: dir, directory: true, exists: true },
      { path: probe.loaded.TOKEN_FILE(), directory: false, exists: true },
    ], 'dir first, then the file, and nothing else');
    // Once per process, not per load: a second read must not re-spawn icacls.
    probe.calls.length = 0;
    const again = probe.loaded.loadToken();
    assert.equal(again.token, out.token);
    assert.equal(again.created, false);
    assert.equal(again.acl, 'private', 'the marker survives a re-read');
    assert.deepEqual(probe.calls, [], 'no icacls per read');
  } finally { probe.restore(); }
}));

test('an inherited token acl is surfaced at startup without echoing the token', async () => {
  await inFreshHome('web-warn', async () => {
    // Write the token with a healthy acl, then start the dashboard from a fresh
    // module whose protection fails: the legacy file case - a token left behind
    // by an older version still has to be reported.
    const writer = withSecureFsRecorder('../lib/web', 'private');
    const written = writer.loaded.loadToken();
    writer.restore();
    assert.equal(written.created, true);

    const probe = withSecureFsRecorder('../lib/web', 'inherited');
    const errLines = [];
    const realErr = console.error;
    console.error = (m) => errLines.push(String(m));
    let server;
    try {
      server = await probe.loaded.startWeb(0, { open: false });
    } finally {
      console.error = realErr;
      probe.restore();
    }
    try {
      assert.equal(probe.calls.filter((c) => !c.directory && c.path === probe.loaded.TOKEN_FILE()).length, 1, 'the existing file is tightened');
      const warn = errLines.filter((l) => /inherited access/.test(l));
      assert.equal(warn.length, 1, `startup says the file kept inherited access: ${JSON.stringify(errLines)}`);
      assert.ok(!warn[0].includes(written.token), 'the warning line never repeats the token');
      assert.ok(!errLines.some((l) => l.includes(written.token)), 'an existing token is not echoed either');
      assert.ok(warn[0].includes('AGENTRELAY_WEB_TOKEN'), 'and it names the way out');
    } finally {
      await close(server);
    }
  });
});

test('a private token acl adds no warning line', async () => {
  await inFreshHome('web-ok', async () => {
    const probe = withSecureFsRecorder('../lib/web', 'private');
    const errLines = [];
    const realErr = console.error;
    console.error = (m) => errLines.push(String(m));
    let server;
    try { server = await probe.loaded.startWeb(0, { open: false }); } finally {
      console.error = realErr;
      probe.restore();
    }
    try {
      assert.equal(errLines.filter((l) => /inherited/.test(l)).length, 0);
      assert.equal(errLines.length, 1, 'exactly the token line');
    } finally { await close(server); }
  });
});

test('inbox protects the store dir and only the sidecars that exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-inbox-'));
  try {
    const file = path.join(root, 'inbox.sqlite');
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(`${file}-wal`, 'x'); // -shm deliberately absent
    const probe = withSecureFsRecorder('../lib/inbox');
    try {
      const acl = probe.loaded.protectStore(file, root);
      assert.equal(acl, 'private');
      assert.deepEqual(probe.calls.map((c) => [c.path, c.directory]), [
        [root, true], [file, false], [`${file}-wal`, false],
      ], '-shm is not protected because it does not exist');
      assert.ok(probe.calls.every((c) => c.exists), 'no protectPath call for a missing path');
    } finally { probe.restore(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opening the inbox store protects it once and reports the aggregate marker', () => {
  inFreshHome('inbox-open', () => {
    const probe = withSecureFsRecorder('../lib/inbox', 'inherited');
    try {
      probe.loaded.create({ fromAddr: 'zcode:a', toAddr: 'zcode:b', agent: 'zcode', sessionId: 'b', text: 'acl probe' });
      const dirs = probe.calls.filter((c) => c.directory);
      const files = probe.calls.filter((c) => !c.directory);
      assert.equal(dirs.length, 1, 'the store dir is protected once per open');
      assert.equal(dirs[0].path, path.dirname(probe.loaded.DB_PATH()));
      assert.ok(files.some((c) => c.path === probe.loaded.DB_PATH()), 'the main db file is protected');
      assert.equal(probe.loaded.acl(), 'inherited', 'a degraded store is visible to callers');
      probe.calls.length = 0;
      probe.loaded.create({ fromAddr: 'zcode:a', toAddr: 'zcode:b', agent: 'zcode', sessionId: 'b', text: 'second row' });
      assert.deepEqual(probe.calls, [], 'no icacls per row');
    } finally { probe.loaded.close(); probe.restore(); }
  });
});

test('mcp tracing protects the log dir once, not per traced call', () => {
  inFreshHome('mcp-log', () => {
    const probe = withSecureFsRecorder('../lib/mcp');
    try {
      const dir = probe.loaded.traceDir();
      const file = path.join(dir, probe.loaded.TRACE_FILE);
      probe.loaded.traceCall('get_paths', {}, '{}', false);
      probe.loaded.traceCall('get_paths', {}, '{}', false);
      probe.loaded.traceCall('get_paths', {}, '{}', false);
      const dirs = probe.calls.filter((c) => c.directory);
      assert.equal(dirs.length, 1, 'icacls runs once for the dir however many calls are traced');
      assert.equal(dirs[0].path, dir);
      const files = probe.calls.filter((c) => !c.directory);
      assert.deepEqual(files.map((c) => c.path), [file], 'the log file itself is protected on creation only');
      assert.equal(probe.loaded.traceAcl(), 'private');

      probe.calls.length = 0;
      fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 10));
      probe.loaded.traceCall('get_paths', {}, '{}', false);
      assert.equal(probe.calls.filter((c) => c.directory).length, 0, 'rotation does not re-protect the dir');
      assert.deepEqual(probe.calls.map((c) => c.path), [file], 'the replacement log is protected');
    } finally { probe.restore(); }
  });
});

test('get_paths reports the acl markers instead of hiding a degraded tree', async () => {
  inFreshHome('mcp-paths', async () => {
    const probe = withSecureFsRecorder('../lib/mcp', 'inherited');
    try {
      const untouched = JSON.parse((await probe.loaded.handleMessage({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_paths', arguments: {} },
      })).result.content[0].text);
      assert.equal(untouched.logDirAcl, null, 'nothing traced yet');
      assert.ok(['inherited', 'private', null].includes(untouched.inboxAcl), 'the inbox marker is reported');

      probe.loaded.traceCall('get_paths', {}, '{}', false);
      const traced = JSON.parse((await probe.loaded.handleMessage({
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_paths', arguments: {} },
      })).result.content[0].text);
      assert.equal(traced.logDir, probe.loaded.traceDir());
      assert.equal(traced.logDirAcl, 'inherited', 'a log dir that could not be tightened is visible to the operator');
    } finally { probe.restore(); }
  });
});

// Task B: adapters keep writing message bodies to disk (their delivery channel),
// so the wiring that matters is that every such write sits in a protected dir and
// is created private. Checked at source level because no exported adapter entry
// point writes a log without launching a real agent. zcode.js is Node's file now.
for (const adapter of ['claude', 'opencode']) {
  test(`lib/adapters/${adapter}.js creates its log tree private and asks secure-fs`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adapters', `${adapter}.js`), 'utf8');
    assert.match(src, /require\('\.\.\/secure-fs'\)/, 'wired to secure-fs');
    assert.match(src, /protectPath\(d, \{ directory: true \}\)/, 'the logs dir is protected as a dir');
    assert.ok(!/if \(process\.platform !== 'win32'\)\s*\{?\s*try \{ fs\.chmodSync/.test(src), 'no win32-skipping chmod helper left behind');
    const modeless = src.split(/\r?\n/).filter((l) =>
      /fs\.mkdirSync\(.*\.openacom.*\)/.test(l) && !/mode: 0o700/.test(l)
      || /fs\.openSync\(\s*log,\s*'a'\s*\)/.test(l)
      || /fs\.writeFileSync\([^)]*message,\s*'utf8'\s*\)/.test(l));
    assert.deepEqual(modeless, [], `no mode-less create: ${JSON.stringify(modeless)}`);
  });
}

// ------------------------------------------------- task G: relay_send consent

// relay_send forwards to the hub's POST /messages. Recording what the tool puts
// on the wire is the only way to prove an omitted consent never turns into an
// approved desktop Enter - the hub itself is another member's file and must not
// be started from here.
function withDistributedRecorder(run) {
  const distPath = require.resolve('../lib/distributed');
  const real = require.cache[distPath];
  const calls = [];
  require.cache[distPath] = {
    id: distPath, filename: distPath, loaded: true,
    exports: {
      request: async (conn, method, route, body) => {
        calls.push({ conn, method, route, body });
        return JSON.stringify({ ok: true, id: 'msg-1' });
      },
    },
  };
  return Promise.resolve(run(calls)).finally(() => {
    if (real === undefined) delete require.cache[distPath]; else require.cache[distPath] = real;
  });
}

const sendVia = (args) => mcp.handleMessage({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'relay_send', arguments: args },
}).then((r) => r.result);

test('relay_send advertises consent as an optional boolean that is off by default', async () => {
  const tools = (await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const schema = tools.find((t) => t.name === 'relay_send').inputSchema;
  assert.equal(schema.properties.consent.type, 'boolean', 'the hub only accepts a literal boolean');
  assert.ok(!schema.required.includes('consent'), 'consent is optional');
  assert.notEqual(schema.properties.consent.default, true, 'the schema cannot default an operator approval on');
});

test('a relay_send without consent puts no consent on the wire', async () => {
  await withDistributedRecorder(async (calls) => {
    const out = await sendVia({ to: 'machine-a', target: 'desktop', text: 'hello' });
    assert.equal(out.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].route, '/messages');
    const body = calls[0].body;
    assert.ok(!('consent' in body), 'absent means absent - the hub decides the default');
    assert.notEqual(body.consent, true, 'consent must never arrive as true by omission');
    assert.ok(!JSON.stringify(body).includes('"consent":true'), `no consent:true anywhere in ${JSON.stringify(body)}`);
  });
});

test('relay_send forwards consent verbatim and refuses a non-boolean instead of coercing it', async () => {
  await withDistributedRecorder(async (calls) => {
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'approved by the operator', consent: true });
    assert.equal(calls[0].body.consent, true, 'an explicit true reaches the hub');
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'draft only', consent: false });
    assert.equal(calls[1].body.consent, false, 'an explicit false stays false');
    const bad = await sendVia({ to: 'machine-a', target: 'desktop', text: 'lenient client', consent: 'true' });
    assert.equal(bad.isError, true, 'a string consent is a client error, not a coerced flag');
    assert.match(bad.content[0].text, /boolean/);
    assert.equal(calls.length, 2, 'the rejected call never reached the hub');
  });
});

// ---------------------------------------------------------------- cleanup
test('cleanup', () => {
  inbox.close();
  fs.rmSync(home, { recursive: true, force: true });
  assert.ok(true);
});
