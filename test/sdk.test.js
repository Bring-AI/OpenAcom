'use strict';
// The SDK must be usable from a plain require() with no CLI behaviour at all: nothing on stdout, no process.exit, no daemon,
// and no write outside AGENTRELAY_HOME. Each test below proves one half of that sentence by running real code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const spawner = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SDK = path.join(ROOT, 'lib', 'sdk.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-sdk-home-'));
process.env.AGENTRELAY_HOME = home;
const hubToken = 'test-only-secret-'.repeat(4);
const sdk = require('../lib/sdk');

function runChild(code) {
  return spawner.spawnSync(process.execPath, ['--experimental-sqlite', '-e', code], { encoding: 'utf8', timeout: 120000, cwd: home });
}

const EXPECTED_SURFACE = [
  'ackMessage', 'agents', 'getPaths', 'inboxMessage', 'inboxMessages', 'listSessions', 'mailbox',
  'postMessage', 'readSession', 'relayNodes', 'relaySend', 'relayStatus', 'send', 'sendMessage', 'sendRouted', 'sendTracked',
];

// Every name lib/index.js published in 0.11.0 has to keep working from the same entry point.
const PUBLISHED_NAMES = ['listSessions', 'readSession', 'send', 'sendTracked', 'inbox', 'hooks', 'web', 'adapters'];

test('requiring the SDK leaves no handle, prints nothing and exits by itself', () => {
  const probe = path.join(home, 'require-probe.json');
  const script = `
    void process.stdout;
    const before = process.getActiveResourcesInfo().length;
    const writes = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    const api = require(${JSON.stringify(SDK)});
    process.stdout.write = real;
    const p = require('path');
    require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify({
      before, after: process.getActiveResourcesInfo().length, writes: writes.length,
      names: Object.keys(api).sort(), types: Object.fromEntries(Object.entries(api).map(([k, v]) => [k, typeof v])),
      loadsIndex: Object.keys(require.cache).includes(p.join(p.dirname(${JSON.stringify(SDK)}), 'index.js')),
    }));
  `;
  const child = runChild(script);
  assert.equal(child.error ? child.error.message : '', '');
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  assert.equal(child.stdout, '', 'require() must not write to stdout');
  const result = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(result.writes, 0);
  assert.equal(result.after, result.before, 'no timer, socket or file handle may be created by require()');
  assert.deepEqual(result.names, EXPECTED_SURFACE);
  assert.equal(result.loadsIndex, false, 'the implementation must not depend on the published facade');
  assert.deepEqual(result.types, Object.fromEntries(EXPECTED_SURFACE.map((name) => [name, name === 'mailbox' ? 'object' : 'function'])));
});

test('the package root stays intact and ./sdk resolution matches the manifest', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['.'], './lib/index.js', 'this wave must not change how require("openacom") resolves');
  assert.equal(manifest.main, 'lib/index.js');
  // A consumer-style resolution through node_modules proves the exports map itself, not just the file name.
  fs.mkdirSync(path.join(home, 'node_modules'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(home, 'node_modules', 'openacom'), 'junction');
  const probe = path.join(home, 'resolve-probe.json');
  const child = runChild(`
    const out = {};
    try {
      out.resolved = require.resolve('openacom/sdk');
      out.keys = Object.keys(require('openacom/sdk')).length;
    } catch (error) { out.code = error.code || 'UNDECLARED'; }
    try { out.root = require.resolve('openacom'); } catch (error) { out.rootCode = error.code || 'UNDECLARED'; }
    require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify(out));
  `);
  assert.equal(child.status, 0, `consumer probe failed: ${child.stderr}`);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, '', 'a consumer require must not write to stdout either');
  const result = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(path.normalize(result.root), path.join(ROOT, 'lib', 'index.js'), result.rootCode);
  if (manifest.exports['./sdk'] === undefined) {
    assert.equal(result.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED', `unexpected resolution state: ${JSON.stringify(result)}`);
    t.diagnostic('exports["./sdk"] is pending on the merge, so require("openacom/sdk") is correctly refused by Node');
    assert.equal(fs.existsSync(SDK), true, 'the file is there; only the manifest key is missing');
    return;
  }
  assert.equal(manifest.exports['./sdk'], './lib/sdk.js');
  assert.equal(result.code, undefined);
  assert.equal(path.normalize(result.resolved), SDK);
  assert.equal(result.keys, EXPECTED_SURFACE.length);
});

test('the proposed exports key resolves a working SDK from a staged copy of the package', () => {
  // Proves the snippet handed to Boss rather than the current manifest: the key is load-bearing and the file behind it works.
  const staged = path.join(home, 'staged-package');
  fs.cpSync(path.join(ROOT, 'lib'), path.join(staged, 'lib'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.exports = { '.': './lib/index.js', './sdk': './lib/sdk.js' };
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify(manifest));
  const consumer = path.join(home, 'staged-consumer');
  fs.mkdirSync(path.join(consumer, 'node_modules'), { recursive: true });
  fs.symlinkSync(staged, path.join(consumer, 'node_modules', 'openacom'), 'junction');
  const probe = path.join(home, 'staged-probe.json');
  const script = `
    const out = {};
    const api = require('openacom/sdk');
    out.resolved = require.resolve('openacom/sdk');
    out.keys = Object.keys(api).sort();
    out.agents = api.agents().sort();
    out.inboxDb = api.getPaths().inboxDb;
    require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify(out));
  `;
  const child = spawner.spawnSync(process.execPath, ['--experimental-sqlite', '-e', script], { cwd: consumer, encoding: 'utf8', timeout: 120000 });
  assert.equal(child.status, 0, `staged consumer failed: ${child.stderr}`);
  assert.equal(child.stdout, '');
  const result = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(path.normalize(result.resolved), path.join(staged, 'lib', 'sdk.js'));
  assert.deepEqual(result.keys, EXPECTED_SURFACE);
  assert.deepEqual(result.agents, ['claude', 'codex', 'opencode', 'zcode']);
  assert.equal(result.inboxDb, path.join(home, 'inbox.sqlite'), 'the staged copy must still honour AGENTRELAY_HOME');
});

test('the published facade keeps every 0.11.0 name and points at the single implementation', () => {
  const facade = require('../lib/index');
  assert.deepEqual(Object.keys(facade).filter((name) => PUBLISHED_NAMES.includes(name)), PUBLISHED_NAMES);
  for (const name of ['listSessions', 'readSession', 'send', 'sendTracked']) {
    assert.equal(facade[name], sdk[name], `relay.${name} must be the same function as sdk.${name}, not a second copy`);
  }
  assert.equal(facade.inbox, sdk.mailbox, 'relay.inbox stays the raw-row namespace');
  assert.deepEqual(Object.keys(facade.inbox).sort(), ['get', 'list', 'markRead', 'path']);
  assert.equal(facade.adapters, require('../lib/core').ADAPTERS, 'adapters stays the registry object itself');
  assert.deepEqual(Object.keys(facade.hooks).sort(), ['EVENTS', 'file', 'load']);
  assert.deepEqual(Object.keys(facade.web).sort(), ['start']);
  for (const name of ['agents', 'sendMessage', 'relaySend', 'relayStatus', 'relayNodes', 'inboxMessages', 'inboxMessage', 'postMessage', 'ackMessage', 'getPaths']) {
    assert.equal(facade[name], sdk[name], `the new ${name} must be reachable from the published entry`);
  }
  // The historical helper names still answer, with stubs only: nothing here reaches a live session.
  assert.ok(facade.hooks.EVENTS().includes('message.sent'));
  assert.equal(facade.hooks.file(), path.join(home, 'hooks.json'));
  assert.equal(typeof facade.hooks.load(), 'object');
  assert.equal(facade.inbox.path(), path.join(home, 'inbox.sqlite'));
  assert.ok(Array.isArray(facade.inbox.list({ limit: 5 })));
  assert.equal(facade.inbox.get(`absent-${randomUUID()}`), null);
});

test('the old send and sendTracked names reject an absent session instead of writing', async () => {
  const facade = require('../lib/index');
  const absent = `absent-${randomUUID()}`;
  await assert.rejects(() => facade.send(absent, 'must not be delivered', { agent: 'claude' }), (error) => error.code === 'SESSION_NOT_FOUND' && error.uncertain === false);
  await assert.rejects(() => facade.sendTracked(absent, 'must not be delivered', { from: 'sdk' }), (error) => error.code === 'SESSION_NOT_FOUND' && error.uncertain === false);
  assert.throws(() => facade.readSession(absent, { agent: 'claude' }), (error) => error.code === 'SESSION_NOT_FOUND');
  assert.equal(typeof facade.send, 'function', 'the fresh-session path stays reachable for existing callers');
});

test('the mailbox round trip stays inside AGENTRELAY_HOME', () => {
  const id = randomUUID();
  const posted = sdk.postMessage('codex:sdk-seat', 'qoder:boss', 'no adapter is touched by this', { id });
  assert.equal(posted.ok, true);
  assert.equal(posted.id, id);
  assert.equal(posted.status, 'sent');
  assert.equal(posted.delivery, 'mailbox');
  assert.deepEqual(sdk.postMessage('codex:sdk-seat', 'qoder:boss', 'no adapter is touched by this', { id }), { ...posted, replayed: true });
  assert.equal(sdk.inboxMessage(id).text, undefined, 'the row shape deliberately carries no body');
  assert.equal(sdk.inboxMessages({ to: 'qoder:boss' }).length, 1);
  assert.deepEqual(sdk.mailbox.get(id).to_addr, 'qoder:boss', 'the raw namespace still returns store columns');
  const acknowledged = sdk.ackMessage(id);
  assert.equal(acknowledged.status, 'read');
  assert.throws(() => sdk.postMessage('bogus address', 'qoder:boss', 'x'), (error) => error.code === 'INVALID_ARGUMENT' && /from/.test(error.message));
  assert.throws(() => sdk.postMessage('codex:sdk-seat', ':boss', 'x'), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => sdk.postMessage('codex:sdk-seat', 'qoder:boss', '  '), (error) => error.code === 'INVALID_ARGUMENT');
  assert.ok(fs.existsSync(path.join(home, 'inbox.sqlite')));
  assert.equal(fs.existsSync(path.join(home, 'hooks.json')), false, 'no hooks file means no spawned child from these calls');
});

test('listSessions returns rows over the known platform keys', () => {
  assert.deepEqual(sdk.agents().slice().sort(), ['claude', 'codex', 'opencode', 'zcode']);
  const rows = sdk.listSessions({ limit: 5 });
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length <= 5);
  for (const row of rows) {
    assert.ok(sdk.agents().includes(row.agent), `unknown agent ${row.agent}`);
    assert.equal(typeof row.id, 'string');
    assert.equal(typeof row.mtime, 'number');
  }
  assert.ok(Array.isArray(sdk.listSessions()));
  assert.throws(() => sdk.listSessions({ agent: 'not-an-agent' }), (error) => error.code === 'UNKNOWN_AGENT' && error.uncertain === false);
  assert.throws(() => sdk.readSession('', {}), (error) => error.code === 'INVALID_ARGUMENT');
});

test('a failing send throws a coded error and never exits the process', async () => {
  await assert.rejects(
    () => sdk.sendMessage('claude', `absent-${randomUUID()}`, 'sdk probe', { from: 'zcode:sdk-probe' }),
    (error) => error.code === 'SESSION_NOT_FOUND' && error.uncertain === false,
    'an unfound session cannot have been written to',
  );
  await assert.rejects(() => sdk.sendMessage('claude', 'x', '  '), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(() => sdk.sendMessage('claude', 'x', 'hi'), (error) => error.code === 'INVALID_ARGUMENT' && /from/.test(error.message));
  await assert.rejects(() => sdk.sendMessage('claude', 'x', 'hi', { from: 'nonsense' }), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(
    () => sdk.sendMessage('not-an-agent', `absent-${randomUUID()}`, 'hi', { from: 'zcode:sdk-probe' }),
    (error) => error.code === 'UNKNOWN_AGENT',
  );
  assert.ok(true, 'reaching this line means none of the five failures exited the process');
});

test('every store path stays inside AGENTRELAY_HOME', () => {
  const paths = sdk.getPaths();
  assert.equal(paths.inboxDb, path.join(home, 'inbox.sqlite'));
  assert.equal(paths.logDir, path.join(home, 'logs'));
  const real = path.join(os.homedir(), '.openacom');
  for (const value of [paths.inboxDb, paths.logDir]) assert.ok(!value.startsWith(real + path.sep), value);
  assert.ok(Array.isArray(sdk.inboxMessages()));
  assert.equal(sdk.inboxMessages({ to: 'nobody:here' }).length, 0);
  assert.equal(sdk.inboxMessage(`absent-${randomUUID()}`), null);
  assert.throws(() => sdk.ackMessage(`absent-${randomUUID()}`), (error) => error.code === 'NOT_FOUND' && error.uncertain === false);
  assert.ok(fs.existsSync(paths.inboxDb), 'the first inbox read created the store in the temp home');
  assert.ok(sdk.inboxMessages({ limit: 1 }).length <= 1, 'the limit is honoured');
});

test('relay calls use the connection passed in opts and keep hub error codes', async () => {
  const { runHub, request } = require('../lib/distributed');
  const hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: path.join(home, 'hub'), token: hubToken });
  const conn = { url: `http://127.0.0.1:${hub.address().port}`, token: hubToken };
  try {
    await request(conn, 'POST', '/nodes/sdk-worker/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    const sent = await sdk.relaySend('sdk-worker', 'coder', 'hello from the sdk', { ...conn, id: randomUUID(), mode: 'draft' });
    assert.equal(sent.status, 'queued');
    assert.equal(sent.consent, false);
    assert.equal(sent.mode, 'draft');
    const status = await sdk.relayStatus(sent.id, conn);
    assert.equal(status.id, sent.id);
    assert.equal(status.retryable, true);
    assert.equal(status.terminal, false);
    const fleet = await sdk.relayNodes(conn);
    assert.ok(fleet.nodes.some((node) => node.id === 'sdk-worker' && node.online));
    assert.equal(fleet.store.paths.length, 2);
    assert.ok(['private', 'inherited'].includes(fleet.store.acl));
    await assert.rejects(() => sdk.relaySend('sdk-worker', 'coder', 'x', { ...conn, consent: 'yes' }), (error) => error.code === 'INVALID_ARGUMENT');
    await assert.rejects(() => sdk.relaySend('ghost-machine', 'coder', 'nobody here', conn), (error) => error.code === 'UNKNOWN_NODE' && error.uncertain === false && error.status === 403);
    await assert.rejects(() => sdk.relayStatus('not-a-uuid', conn), (error) => error.code === 'INVALID_ID' && error.uncertain === false);
    await assert.rejects(() => sdk.relayNodes({ url: 'http://127.0.0.1:1', token: hubToken }), (error) => typeof error.code === 'string' && error.code !== 'INVALID_ARGUMENT');
  } finally {
    await new Promise((resolve, reject) => hub.close((error) => error ? reject(error) : resolve()));
  }
});

test('no call writes to stdout, and failures throw instead of exiting', () => {
  // Patching the stdout stream in-process would capture the test reporter too, so this runs a real child.
  const probe = path.join(home, 'stdout-probe.json');
  const script = `
    const api = require(${JSON.stringify(SDK)});
    const writes = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    const failed = [];
    const trap = (name) => (error) => { failed.push(name + ':' + ((error && error.code) || String(error))); };
    const guarded = (name, run) => Promise.resolve().then(run).catch(trap(name));
    Promise.all([
      guarded('getPaths', () => api.getPaths()),
      guarded('inboxMessages', () => api.inboxMessages()),
      guarded('agents', () => api.agents()),
      guarded('listSessions', () => api.listSessions({ limit: 1 })),
      guarded('sendMessage', () => api.sendMessage('claude', 'absent-session', 'text', { from: 'zcode:probe' })),
      guarded('relayNodes', () => api.relayNodes({ url: 'http://127.0.0.1:1', token: ${JSON.stringify(hubToken)} })),
    ]).then(() => {
      process.stdout.write = real;
      require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ writes, failed }));
    }, (error) => { process.stdout.write = real; real('child crashed: ' + error.message + '\\n'); process.exitCode = 1; });
  `;
  const child = runChild(script);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '', 'the SDK must never write to stdout, including on failures');
  const result = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.deepEqual(result.writes, [], 'nothing was captured on the patched stream either');
  assert.ok(result.failed.includes('sendMessage:SESSION_NOT_FOUND'), result.failed.join(','));
  assert.ok(result.failed.some((entry) => /^relayNodes:[A-Z_]+$/.test(entry)), result.failed.join(','));
  assert.equal(result.failed.length, 2, `only the two unreachable calls may fail: ${result.failed.join(',')}`);
});

test('teardown drops the consumer link and the temp home', () => {
  require('../lib/inbox').close();
  const link = path.join(home, 'node_modules', 'openacom');
  try { fs.unlinkSync(link); } catch { /* already gone */ }
  assert.equal(fs.existsSync(link), false, 'the junction into the repository must not survive');
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, maxRetryTime: 2000 }); } catch { /* a locked sqlite file may outlive the run */ }
});

