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
// A hub request pair: the bootstrap credential enqueues and registers, while a
// node may only ever act with the credential the hub issued to it (H1).
const via = (hub, bearer = token) => ({ url: `http://127.0.0.1:${hub.address().port}`, token: bearer });

test('queues are durable, credential-bound and refuse unknown destinations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-queue-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    let conn = via(hub);
    // H1: 'to' is no longer a free-form string - an unregistered queue rejects.
    await assert.rejects(request(conn, 'POST', '/messages', { id: randomUUID(), to: 'never-seen', target: 'coder', text: 'hello', mode: 'submit' }), { status: 403, code: 'UNKNOWN_NODE' });
    const instanceId = randomUUID();
    const sessionId = randomUUID();
    const registration = await request(conn, 'POST', '/nodes/offline-machine/heartbeat', { instanceId, sessionId, targets: ['coder'] });
    assert.equal(registration.ok, true);
    assert.equal(typeof registration.nodeToken, 'string');
    assert.ok(registration.nodeToken.length >= 32);
    const input = { id: randomUUID(), to: 'offline-machine', target: 'coder', text: '你好\ncontinue', mode: 'submit' };
    // A node credential cannot enqueue or list the fleet; that stays bootstrap work.
    await assert.rejects(request(via(hub, registration.nodeToken), 'POST', '/messages', input), { status: 403, code: 'ADMIN_CREDENTIAL_REQUIRED' });
    await assert.rejects(request(via(hub, registration.nodeToken), 'GET', '/nodes'), { status: 403, code: 'ADMIN_CREDENTIAL_REQUIRED' });
    const initial = await request(conn, 'POST', '/messages', input);
    assert.equal(initial.status, 'queued');
    assert.equal(initial.retryable, true);
    assert.equal(initial.terminal, false);
    assert.equal(initial.everUncertain, false);
    assert.equal(initial.attempts, 0);
    assert.ok(initial.expiresAt > initial.createdAt, 'M6: every queued item carries a stored TTL');
    assert.equal((await request(conn, 'POST', '/messages', input)).id, input.id);
    await assert.rejects(request(conn, 'POST', '/messages', { ...input, text: 'different' }), { status: 409 });
    await assert.rejects(request({ ...conn, token: 'wrong-token-'.repeat(4) }, 'GET', `/messages/${input.id}`), { status: 401 });
    await assert.rejects(request(conn, 'POST', '/messages', { ...input, id: randomUUID(), text: '\x1b[201~injected' }), { status: 400 });
    // H1: a valid hub secret is not a licence to read another node's queue. The
    // bootstrap credential cannot poll at all, and a foreign node credential is
    // refused for the right node id.
    const poll = `/messages?to=offline-machine&sessionId=${sessionId}`;
    await assert.rejects(request(conn, 'GET', poll), { status: 403, code: 'NODE_CREDENTIAL_REQUIRED' });
    const stranger = await request(conn, 'POST', '/nodes/other-machine/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    await assert.rejects(request(via(hub, stranger.nodeToken), 'GET', poll), { status: 403, code: 'NODE_FORBIDDEN' });
    await assert.rejects(request(via(hub, 'x'.repeat(40)), 'GET', poll), { status: 401 });
    await stop(hub); hub = null;
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    conn = via(hub);
    const recovered = await request(conn, 'GET', `/messages/${input.id}`);
    assert.equal(recovered.text, input.text);
    assert.equal(recovered.status, 'queued');
    assert.equal((await request(conn, 'POST', '/messages', input)).id, input.id);
    // The credential the hub issued before the restart still owns the queue.
    const afterRestart = via(hub, registration.nodeToken);
    assert.equal((await request(afterRestart, 'GET', `/messages?to=${input.to}&sessionId=${sessionId}`)).message.status, 'delivering');
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
    let conn = via(hub);
    const instanceId = randomUUID(), sessionId = randomUUID();
    const registration = await request(conn, 'POST', '/nodes/worker/heartbeat', { instanceId, sessionId, targets: ['coder'] });
    let worker = via(hub, registration.nodeToken);
    const input = { id: randomUUID(), to: 'worker', target: 'coder', text: 'do not duplicate me', mode: 'submit' };
    await request(conn, 'POST', '/messages', input);
    const route = `/messages?to=worker&sessionId=${sessionId}`;
    const first = await request(worker, 'GET', route);
    assert.equal(first.message.id, input.id);
    assert.equal(first.message.attempts, 1);
    assert.equal((await request(worker, 'GET', route)).message.claimId, first.message.claimId);
    await assert.rejects(request(worker, 'GET', `/messages?to=worker&sessionId=${randomUUID()}`), { status: 409 });
    await stop(hub); hub = null;
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    conn = via(hub);
    worker = via(hub, registration.nodeToken);
    const uncertain = await request(conn, 'GET', `/messages/${input.id}`);
    assert.equal(uncertain.status, 'uncertain');
    // M4: the restart opened uncertainty, it did not close it. The hub records
    // what it does not know instead of quietly deciding for the node.
    assert.equal(uncertain.everUncertain, true);
    assert.equal(uncertain.settlement, 'awaiting-node-evidence');
    assert.equal(uncertain.retryable, false);
    assert.equal(uncertain.terminal, false);
    const newSession = randomUUID();
    // A restarted node keeps its own credential and takes a fresh session.
    await request(worker, 'POST', '/nodes/worker/heartbeat', { instanceId, sessionId: newSession, targets: ['coder'] });
    assert.equal((await request(worker, 'GET', `/messages?to=worker&sessionId=${newSession}`)).message, null);
    const unknown = await request(conn, 'POST', '/messages', { ...input, id: randomUUID(), target: 'not-allowed' });
    assert.equal((await request(worker, 'GET', `/messages?to=worker&sessionId=${newSession}`)).message, null);
    assert.equal((await request(conn, 'GET', `/messages/${unknown.id}`)).status, 'failed');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
