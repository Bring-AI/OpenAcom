'use strict';
// Wave 8 (task #18): the async mailbox. codex -> qoder has no safe live
// injection channel (Qoder has no CLI stdin and we never drive the IDE UI), so
// post_message leaves a row in the existing read-receipt store and the recipient
// picks it up with inbox + ack_message. Every test here runs against a throwaway
// AGENTRELAY_HOME, and the four adapters are replaced by spies before lib/core
// loads, so "nothing was delivered to a live session" is asserted, not assumed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-mbox-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.AGENTRELAY_WEB_TOKEN;
delete process.env.AGENTRELAY_URL;
delete process.env.AGENTRELAY_TOKEN;
delete process.env.OPENACOM_AGENT_ID;
delete process.env.AGENTRELAY_AGENT_ID;

const adapterCalls = [];
const LIVE_ZCODE = { id: 'sess-1', agent: 'zcode', title: 'live', workspace: 'F:/Work/live', mtime: 1 };
const stubbedAdapters = [];
for (const name of ['zcode', 'claude', 'codex', 'opencode']) {
  const file = path.join(__dirname, '..', 'lib', 'adapters', `${name}.js`);
  const resolved = require.resolve(file);
  stubbedAdapters.push([resolved, require.cache[resolved]]);
  const live = name === 'zcode';
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: {
      name,
      available: () => live,
      list: () => (live ? [{ ...LIVE_ZCODE }] : []),
      get: (id) => (live && id === LIVE_ZCODE.id ? { ...LIVE_ZCODE } : null),
      messages: () => [],
      cliPath: () => null,
      send: async (...a) => { adapterCalls.push([name, 'send', a]); throw new Error(`${name}.send must not run for a mailbox post`); },
      sendFresh: (...a) => { adapterCalls.push([name, 'sendFresh', a]); throw new Error(`${name}.sendFresh must not run for a mailbox post`); },
      sendDesktop: (...a) => { adapterCalls.push([name, 'sendDesktop', a]); throw new Error(`${name}.sendDesktop must not run for a mailbox post`); },
    },
  };
}

const mcp = require('../lib/mcp');
const inbox = require('../lib/inbox');
const groups = require('../lib/groups');

function readLog() {
  const f = path.join(mcp.traceDir(), mcp.TRACE_FILE);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

const call = async (name, args) => (await mcp.handleMessage({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
})).result;

const toolText = (result) => result.content[0].text;
const rows = async (args) => JSON.parse(toolText(await call('inbox', args)));

test('post_message leaves a mailbox row and never touches an adapter', async () => {
  const out = JSON.parse(toolText(await call('post_message', {
    from: 'codex:sess-77', to: 'qoder:boss', text: 'CI 红了，帮忙看下 3 号流水线',
  })));
  assert.equal(out.ok, true);
  assert.equal(out.status, 'sent', 'the post is the delivery, so it lands on sent');
  assert.equal(out.delivery, 'mailbox');
  assert.equal(adapterCalls.length, 0, 'no send/sendFresh/sendDesktop ran - no live session was touched');
  const row = inbox.get(out.id);
  assert.equal(row.to_addr, 'qoder:boss');
  assert.equal(row.from_addr, 'codex:sess-77');
  assert.equal(row.agent, 'qoder', 'the recipient half of the address is what a session-less row can record');
  assert.equal(row.session_id, 'boss');
  assert.equal(row.text, 'CI 红了，帮忙看下 3 号流水线');
  assert.equal(row.delivery, 'mailbox');
  assert.equal(row.attempts, 1, 'one attempt: the write');
  assert.equal(row.max_attempts, 1, 'nothing to redeliver, so nothing can retry it');
  assert.equal(row.last_error, null);
});

test('the recipient lists it by address and settles it with the shared ack', async () => {
  const posted = JSON.parse(toolText(await call('post_message', { from: 'codex:s1', to: 'qoder:boss', text: 'ping' })));
  const mine = await rows({ to: 'qoder:boss' });
  assert.ok(mine.some((r) => r.id === posted.id && r.delivery === 'mailbox'), 'the to: filter reads the mail left for it');
  assert.equal(mine.every((r) => r.to === 'qoder:boss'), true, 'no other address leaks into the filter');
  assert.equal((await rows({ to: 'qoder:nobody' })).length, 0, 'an empty box is empty, not an error');
  const outbound = await rows({ from: 'codex:s1' });
  assert.ok(outbound.some((r) => r.id === posted.id), 'the sender can list what it posted');

  const acked = JSON.parse(toolText(await call('ack_message', { id: posted.id })));
  assert.equal(acked.status, 'read');
  assert.ok(acked.readAt > 0);
  assert.ok((await rows({ to: 'qoder:boss', status: 'read' })).some((r) => r.id === posted.id), 'the lifecycle is the existing sent -> read one');
  assert.equal(adapterCalls.length, 0, 'reading and acking a mailbox row never delivers either');
});

test('a stable id replays and a changed payload conflicts without overwriting', async () => {
  const first = JSON.parse(toolText(await call('post_message', { id: 'mail-retry-1', from: 'codex:s2', to: 'qoder:boss', text: 'same bytes' })));
  assert.equal(first.replayed, undefined, 'a fresh post is not a replay');
  const again = JSON.parse(toolText(await call('post_message', { id: 'mail-retry-1', from: 'codex:s2', to: 'qoder:boss', text: 'same bytes' })));
  assert.equal(again.replayed, true, 'the caller can retry blindly with the same payload');
  assert.equal((await rows({})).filter((r) => r.id === 'mail-retry-1').length, 1, 'exactly one row for that id');

  const clash = await call('post_message', { id: 'mail-retry-1', from: 'codex:s2', to: 'qoder:boss', text: 'different text' });
  assert.equal(clash.isError, true, 'a stored id may not be replayed with other content');
  assert.match(toolText(clash), /ID_CONFLICT/);
  assert.equal(inbox.get('mail-retry-1').text, 'same bytes', 'the original body survived');
  // An id already taken by a tracked send is a conflict too, not a re-tag.
  inbox.create({ id: 'tracked-1', fromAddr: 'zcode:a', toAddr: 'zcode:b', agent: 'zcode', sessionId: 'b', text: 'via adapter' });
  const hijack = await call('post_message', { id: 'tracked-1', from: 'codex:s2', to: 'qoder:boss', text: 'via adapter' });
  assert.equal(hijack.isError, true);
  assert.match(toolText(hijack), /ID_CONFLICT/);
  assert.equal(inbox.get('tracked-1').delivery, null, 'a tracked row keeps its own delivery kind');
});

test('post_message text lands in the trace only as a length and digest', async () => {
  const secret = 'MAILBOX-PLAINTEXT-不得落盘 ' + 'x'.repeat(40);
  await call('post_message', { from: 'codex:s3', to: 'qoder:boss', text: secret });
  const log = readLog();
  assert.ok(log.length > 0, 'the call was traced');
  assert.ok(!log.includes('MAILBOX-PLAINTEXT'), `raw body reached the log: ${JSON.stringify(log.slice(-300))}`);
  assert.ok(!log.includes('不得落盘'), 'raw unicode body must not reach the log');
  assert.match(log, /"text":"len=\d+ sha256:[0-9a-f]{12}"/);
  assert.equal(adapterCalls.length, 0);
});

test('bad addresses, empty text and a broken id are refused before anything is stored', async () => {
  for (const args of [
    { from: 'codex:s4', to: 'qoder', text: 'no colon' },
    { from: 'boss', to: 'qoder:boss', text: 'sender without an address' },
    { from: 'codex:s4', to: 'qoder:boss', text: '   ' },
    { from: 'codex:s4', to: 'qoder:boss', text: 42 },
    { from: 'codex:s4', to: 'qoder:boss', text: 'bad id type', id: 7 },
    { from: 'codex:s4', to: 'qoder:boss', text: 'long id', id: 'x'.repeat(201) },
  ]) {
    const bad = await call('post_message', args);
    assert.equal(bad.isError, true, `rejected: ${JSON.stringify(args)}`);
    assert.equal(adapterCalls.length, 0);
  }
  assert.equal((await rows({ to: 'qoder' })).length, 0);
  assert.equal((await rows({ from: 'codex:s4' })).length, 0, 'a rejected post writes no row');
});

test('the mailbox rows live in the same protected store as tracked sends', () => {
  assert.notEqual(inbox.acl(), null, 'the store was opened and its acl surfaced');
  assert.ok(['private', 'inherited'].includes(inbox.acl()));
  assert.equal(fs.existsSync(inbox.DB_PATH()), true, 'one store, two message kinds - no second file');
  assert.match(inbox.DB_PATH(), /inbox\.sqlite$/);
});

test('a store written before the delivery column exists is upgraded, not rebuilt', async () => {
  const legacyHome = path.join(home, 'legacy');
  fs.mkdirSync(legacyHome, { recursive: true });
  const file = path.join(legacyHome, 'inbox.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, agent TEXT NOT NULL,
    session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, read_at INTEGER)`);
  const real = legacy.prepare(`INSERT INTO messages (id, from_addr, to_addr, agent, session_id, text, status, created_at, updated_at)
    VALUES ('old-1','zcode:a','zcode:b','zcode','b','written before the column existed','read',1,1)`).run();
  assert.equal(real.changes, 1);
  legacy.close();

  const inboxPath = require.resolve('../lib/inbox');
  const cached = require.cache[inboxPath];
  const savedHome = process.env.AGENTRELAY_HOME;
  process.env.AGENTRELAY_HOME = legacyHome;
  delete require.cache[inboxPath];
  try {
    const upgraded = require('../lib/inbox');
    assert.equal(upgraded.list({}).length, 1, 'the old row is still there');
    assert.equal(upgraded.list({})[0].delivery, null, 'and it reads as the legacy kind');
    const posted = upgraded.post({ id: 'new-1', fromAddr: 'codex:s9', toAddr: 'qoder:boss', text: 'after upgrade' });
    assert.equal(posted.row.delivery, 'mailbox', 'the column was added, not requested and lost');
    assert.equal(upgraded.list({ toAddr: 'qoder:boss' }).length, 1);
    upgraded.close();
  } finally {
    process.env.AGENTRELAY_HOME = savedHome;
    require.cache[inboxPath] = cached;
  }
  assert.equal(adapterCalls.length, 0);
});

// --------------------------- wave 10 (#22): the default send stores, never injects
// send_message now writes an inbox row unless inject:true is passed, so a target
// with no injection channel (qoder, qoder-<name>) is reached by the same verb and
// the same rules as one that has it. Nothing on the default path may deliver,
// spawn, or imply a read. Only secure-fs's own icacls (tightening the store) is
// tolerated - no agent, CLI or shell process.
function withoutSpawns(run) {
  const cp = require('child_process');
  const real = {};
  const seen = [];
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    real[method] = cp[method];
    cp[method] = (...a) => {
      const target = String(a[0]);
      if (method === 'spawnSync' && /icacls/i.test(target)) return real[method](...a);
      seen.push(`${method}:${target}`);
      throw new Error(`the default send must not spawn (${method} ${target})`);
    };
  }
  return Promise.resolve(run(seen)).finally(() => { for (const m of Object.keys(real)) cp[m] = real[m]; });
}

test('explicit inject:false into a live session only stores a row', async () => {
  await withoutSpawns(async (spawns) => {
    const before = adapterCalls.length;
    const out = JSON.parse(toolText(await call('send_message', { inject: false, from: 'codex:s1', to: 'zcode:sess-1', message: 'no rush' })));
    assert.equal(out.status, 'mailbox-delivered');
    assert.equal(out.delivery, 'mailbox-send');
    assert.equal(out.to, 'zcode:sess-1');
    const row = inbox.get(out.id);
    assert.equal(row.status, 'sent', 'the row lifecycle is the existing sent -> read one');
    assert.equal(row.text, 'no rush', 'no receipt footer is invented on the store path');
    assert.equal(adapterCalls.length, before, 'sess-1 is driveable and was still not touched');
    assert.deepEqual(spawns, []);
    assert.equal(JSON.parse(toolText(await call('ack_message', { id: out.id }))).status, 'read');
  });
});

test('send_message to qoder queues a mailbox row without touching an adapter or a process', async () => {
  await withoutSpawns(async (spawns) => {
    const out = JSON.parse(toolText(await call('send_message', { inject: false, to: 'qoder:boss', message: 'CI 红了，帮忙看下' })));
    assert.equal(out.status, 'mailbox-delivered', 'stored for the target to read - not injected, not read');
    assert.equal(out.to, 'qoder:boss');
    assert.equal(out.delivery, 'mailbox-bridge');
    assert.equal(out.from, groups.identity().agentId, 'an undeclared caller defaults to its local identity');
    const row = inbox.get(out.id);
    assert.equal(row.session_id, 'boss');
    assert.equal(row.agent, 'qoder');
    assert.equal(row.text, 'CI 红了，帮忙看下', 'the body is stored verbatim - no invented footer');
    assert.equal(row.delivery, 'mailbox-bridge');
    assert.equal(adapterCalls.length, 0, 'no adapter ran');
    assert.deepEqual(spawns, [], 'no process was spawned');
    const acked = JSON.parse(toolText(await call('ack_message', { id: out.id })));
    assert.equal(acked.status, 'read', 'the bridge seat settles it with the existing ack');
  });
});

test('qoder-<name> bridges too, and a declared from address is kept', async () => {
  await withoutSpawns(async (spawns) => {
    const out = JSON.parse(toolText(await call('send_message', { inject: false, from: 'codex:s9', to: 'qoder-ide:win1', message: 'review please' })));
    assert.equal(out.status, 'mailbox-delivered');
    assert.equal(out.from, 'codex:s9');
    const row = inbox.get(out.id);
    assert.equal(row.to_addr, 'qoder-ide:win1');
    assert.equal(row.agent, 'qoder-ide');
    assert.equal(row.session_id, 'win1');
    assert.equal(adapterCalls.length, 0);
    assert.deepEqual(spawns, []);
  });
});

test('injection options without inject:true are refused, not silently downgraded', async () => {
  const live = await call('send_message', { inject: false, from: 'codex:s1', to: 'zcode:sess-1', message: 'old caller', wait: true });
  assert.equal(live.isError, true);
  assert.match(toolText(live), /^INJECT_REQUIRED:/);
  assert.match(toolText(live), /wait/, 'the refusal names the option that asked for injection');
  const receipt = await call('send_message', { inject: false, from: 'codex:s1', to: 'zcode:sess-1', message: 'old caller', requireRead: true });
  assert.match(toolText(receipt), /requireRead/);
  // A target with no injection channel gets the other code: no advice to pass a
  // flag that could not work either.
  const qoder = await call('send_message', { inject: false, to: 'qoder:boss', message: 'blocking?', wait: true, requireRead: true });
  assert.equal(qoder.isError, true);
  assert.match(toolText(qoder), /^INJECT_UNSUPPORTED:/);
  assert.ok(!inbox.list({ toAddr: 'zcode:sess-1' }).some((r) => r.text === 'old caller'), 'a refused send stored nothing either');
});

test('inject:true is the expedited path and still reaches the adapter', async () => {
  const before = adapterCalls.length;
  const out = await call('send_message', { inject: true, from: 'codex:s1', to: 'zcode:sess-1', message: 'real injection' });
  assert.equal(out.isError, true, 'the stubbed zcode adapter throws on purpose');
  assert.match(toolText(out), /must not run for a mailbox post/, 'the adapter path was taken');
  assert.equal(adapterCalls.length, before + 1);
  assert.ok(!toolText(out).includes('mailbox-delivered'), 'an injected send never reports the stored-result shape');
  const noSender = await call('send_message', { inject: true, to: 'zcode:sess-1', message: 'who am I' });
  assert.match(toolText(noSender), /"from" is required/, 'injection still needs the sender address');
});

test('zcode:new is injection by definition', async () => {
  const before = adapterCalls.length;
  const defaulted = await call('send_message', { inject: false, from: 'codex:s1', to: 'zcode:new', message: 'make me a session' });
  assert.equal(defaulted.isError, true);
  assert.match(toolText(defaulted), /INJECT_REQUIRED/);
  assert.equal(adapterCalls.length, before, 'no fresh session was created behind the flag');
  const injected = await call('send_message', { inject: true, from: 'codex:s1', to: 'zcode:new', message: 'make me a session' });
  assert.equal(injected.isError, true, 'the stubbed sendFresh throws on purpose');
  assert.match(toolText(injected), /sendFresh must not run/);
});

// --------------------------- address grammar: sender is any agent, target is not
// Boss hit this with from="qoder:eab70a5c-…" being refused while post_message
// already accepted it: one address space, one grammar constant.
test('a qoder sender passes the format gate and reaches the live target path', async () => {
  const missing = await call('send_message', { inject: false,
    inject: true, from: 'qoder:eab70a5c-05f0-441e-b674-780191975edf', to: 'zcode:no-such-session', message: 'replying upstream',
  });
  assert.equal(missing.isError, true);
  assert.match(toolText(missing), /target session not found on zcode/, 'rejected for the session, not for the address shape');
  assert.ok(!/invalid "from"/.test(toolText(missing)), 'the sender grammar is no longer four platforms deep');

  const before = adapterCalls.length;
  const reached = await call('send_message', { inject: false,
    inject: true, from: 'qoder:eab70a5c-05f0-441e-b674-780191975edf', to: 'zcode:sess-1', message: 'real injection from a qoder sender',
  });
  assert.equal(reached.isError, true, 'the stubbed adapter throws on purpose once the gate lets it through');
  assert.equal(adapterCalls.length, before + 1, 'the send really routed to the adapter');
});

test('address shapes that were never valid stay rejected', async () => {
  for (const from of ['qoder', ':x', '9bad:x', 'qoder:', 'qoder:  ']) {
    const out = await call('send_message', { inject: false, from, to: 'zcode:sess-1', message: 'bad sender' });
    assert.equal(out.isError, true, `must reject from=${JSON.stringify(from)}`);
    assert.match(toolText(out), /invalid "from"/);
  }
  for (const to of ['qoder', ':x', '9bad:x', '']) {
    const out = await call('send_message', { inject: false, from: 'codex:s1', to, message: 'bad target' });
    assert.equal(out.isError, true, `must reject to=${JSON.stringify(to)}`);
    assert.match(toolText(out), /invalid "to"|"to" is required/);
  }
});

test('the schema offers inject and no longer demands from', async () => {
  const tools = (await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const send = tools.find((t) => t.name === 'send_message').inputSchema;
  assert.equal(send.properties.inject.type, 'boolean', 'the expedited path is opt-in by name');
  assert.deepEqual(send.required, ['to', 'message'], 'a default store needs no sender claim');
});

test('a qoder target still never reaches an adapter - it only stores', async () => {
  const before = adapterCalls.length;
  const out = JSON.parse(toolText(await call('send_message', { inject: false, from: 'codex:s1', to: 'qoder:x', message: 'drive qoder' })));
  assert.equal(out.status, 'mailbox-delivered');
  assert.equal(adapterCalls.length, before, 'the injection surface for qoder is still nothing');
  assert.equal(inbox.get(out.id).delivery, 'mailbox-bridge');
});

test('cleanup', () => {
  inbox.close();
  for (const [resolved, entry] of stubbedAdapters) {
    if (entry === undefined) delete require.cache[resolved]; else require.cache[resolved] = entry;
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  assert.equal(fs.existsSync(home), false, 'the throwaway store is gone - nothing left in the real home');
});

