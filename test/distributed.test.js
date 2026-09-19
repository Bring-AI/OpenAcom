'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runHub, request } = require('../lib/distributed');
const token = 'test-only-secret-'.repeat(4);
async function stop(server) { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }

test('queued message survives restart and enqueue retries cannot alter it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-queue-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    let conn = { url: `http://127.0.0.1:${hub.address().port}`, token };
    const input = { id: randomUUID(), to: 'offline-machine', target: 'coder', text: '你好\ncontinue', mode: 'submit' };
    const initial = await request(conn, 'POST', '/messages', input);
    assert.equal(initial.status, 'queued');
    assert.equal((await request(conn, 'POST', '/messages', input)).id, input.id);
    await assert.rejects(request(conn, 'POST', '/messages', { ...input, text: 'different' }), { status: 409 });
    await assert.rejects(request({ ...conn, token: 'wrong-token-'.repeat(4) }, 'GET', `/messages/${input.id}`), { status: 401 });
    await assert.rejects(request(conn, 'POST', '/messages', { ...input, id: randomUUID(), text: '\x1b[201~injected' }), { status: 400 });
    await stop(hub); hub = null;
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    conn = { url: `http://127.0.0.1:${hub.address().port}`, token };
    const recovered = await request(conn, 'GET', `/messages/${input.id}`);
    assert.equal(recovered.text, input.text);
    assert.equal(recovered.status, 'queued');
    assert.equal((await request(conn, 'POST', '/messages', input)).id, input.id);
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claim is exclusive and hub restart never automatically replays UI side effects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-claim-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    let conn = { url: `http://127.0.0.1:${hub.address().port}`, token };
    const instanceId = randomUUID(), sessionId = randomUUID();
    await request(conn, 'POST', '/nodes/worker/heartbeat', { instanceId, sessionId, targets: ['coder'] });
    const input = { id: randomUUID(), to: 'worker', target: 'coder', text: 'do not duplicate me', mode: 'submit' };
    await request(conn, 'POST', '/messages', input);
    const route = `/messages?to=worker&sessionId=${sessionId}`;
    const first = await request(conn, 'GET', route);
    assert.equal(first.message.id, input.id);
    assert.equal((await request(conn, 'GET', route)).message.claimId, first.message.claimId);
    await assert.rejects(request(conn, 'GET', `/messages?to=worker&sessionId=${randomUUID()}`), { status: 409 });
    await stop(hub); hub = null;
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    conn = { url: `http://127.0.0.1:${hub.address().port}`, token };
    assert.equal((await request(conn, 'GET', `/messages/${input.id}`)).status, 'uncertain');
    const newSession = randomUUID();
    await request(conn, 'POST', '/nodes/worker/heartbeat', { instanceId, sessionId: newSession, targets: ['coder'] });
    assert.equal((await request(conn, 'GET', `/messages?to=worker&sessionId=${newSession}`)).message, null);
    const unknown = await request(conn, 'POST', '/messages', { ...input, id: randomUUID(), target: 'not-allowed' });
    assert.equal((await request(conn, 'GET', `/messages?to=worker&sessionId=${newSession}`)).message, null);
    assert.equal((await request(conn, 'GET', `/messages/${unknown.id}`)).status, 'failed');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
