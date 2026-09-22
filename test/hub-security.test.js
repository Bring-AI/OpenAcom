'use strict';
// Coverage for the wave-3 hub fixes: per-node credentials (H1), uncertainty that
// only the owning node can settle (M4), deferred vs uncertain separation (M5),
// and bounded queues (M6). Each test starts its own hub on a random port and
// closes it, so nothing lingers on 9330 and no real agent session is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { runHub, request, classifyFailure, targetFilePermissionProblem, MAX_DEFERRALS, DEFERRABLE_CODES } = require('../lib/distributed');
const token = 'test-only-secret-'.repeat(4);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop(server) { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
const via = (hub, bearer = token) => ({ url: `http://127.0.0.1:${hub.address().port}`, token: bearer });

// Offline edit of hub state between two hub lifetimes, used to move time-based
// gates (retry backoff, deferral budget) forward without slowing tests down.
function withHubStore(dir, edit) {
  const db = new DatabaseSync(path.join(dir, 'hub.sqlite'));
  try { db.exec('PRAGMA busy_timeout = 5000;'); edit(db); } finally { db.close(); }
}

// Start a hub with one registered 'worker' node. `credential` is the node token
// from an earlier lifetime: after registration a node heartbeats with its own
// credential, because the bootstrap secret no longer buys it anything (H1).
async function nodeHub(dir, options = {}, credential) {
  const hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token, ...options });
  const admin = via(hub);
  const sessionId = randomUUID();
  const instanceId = randomUUID();
  const registration = await request({ url: admin.url, token: credential || token }, 'POST', '/nodes/worker/heartbeat', {
    instanceId, sessionId, targets: ['coder'],
  });
  return { hub, admin, sessionId, instanceId, token: registration.nodeToken || credential };
}

test('queue depth is capped per node and overflow is a machine-readable 429', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-quota-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token, nodeQueueLimit: 3 });
    const admin = via(hub);
    const worker = await request(admin, 'POST', '/nodes/worker/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    await request(admin, 'POST', '/nodes/second/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    const sent = [];
    for (let index = 0; index < 3; index++) {
      const input = { to: 'worker', target: 'coder', text: `item ${index}` };
      const queued = await request(admin, 'POST', '/messages', input);
      // Keep the hub-assigned id so a later resend is an idempotent replay instead
      // of a fourth message.
      sent.push({ input: { ...input, id: queued.id }, queued });
    }
    let rejection;
    try {
      await request(admin, 'POST', '/messages', { to: 'worker', target: 'coder', text: 'one too many' });
    } catch (error) { rejection = error; }
    assert.equal(rejection.status, 429);
    assert.equal(rejection.code, 'QUEUE_FULL');
    assert.match(rejection.message, /limit 3/);
    // The quota is per node, not global: an unrelated queue still accepts work.
    assert.equal((await request(admin, 'POST', '/messages', { to: 'second', target: 'coder', text: 'fits' })).status, 'queued');
    // Idempotent resend of an accepted id must not be pushed out by the quota.
    assert.equal((await request(admin, 'POST', '/messages', sent[0].input)).id, sent[0].queued.id);
    // Settling frees room, so a sender that waits is not locked out forever.
    const sessionId = randomUUID();
    await request(via(hub, worker.nodeToken), 'POST', '/nodes/worker/heartbeat', { instanceId: randomUUID(), sessionId, targets: ['coder'] });
    const claim = (await request(via(hub, worker.nodeToken), 'GET', `/messages?to=worker&sessionId=${sessionId}`)).message;
    await request(via(hub, worker.nodeToken), 'POST', `/messages/${claim.id}/ack`, {
      nodeId: 'worker', claimId: claim.claimId, status: 'delivered',
      result: { status: 'submitted', outcome: 'input-submitted', messageId: claim.id },
    });
    assert.equal((await request(admin, 'POST', '/messages', { to: 'worker', target: 'coder', text: 'room again' })).status, 'queued');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queue TTL expires untouched work and survives a hub restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-ttl-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token, queueTtlMs: 30 });
    const admin = via(hub);
    const sessionId = randomUUID();
    const registration = await request(admin, 'POST', '/nodes/worker/heartbeat', { instanceId: randomUUID(), sessionId, targets: ['coder'] });
    const queued = await request(admin, 'POST', '/messages', { to: 'worker', target: 'coder', text: 'age me out' });
    assert.equal(queued.expiresAt - queued.createdAt, 30);
    await sleep(60);
    // Expiry runs on the ordinary request path, so simply reading the message
    // proves the hub ages work out without a background timer (M6).
    const expired = await request(admin, 'GET', `/messages/${queued.id}`);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.error.code, 'QUEUE_EXPIRED');
    assert.equal(expired.terminal, true);
    assert.equal(expired.retryable, false);
    assert.equal(expired.everUncertain, false, 'never attempted, so never uncertain');
    // The explicit route reports the same maintenance as machine-readable counts.
    const pruned = await request(admin, 'POST', '/queue/prune');
    assert.equal(typeof pruned.expired, 'number');
    assert.equal(typeof pruned.deleted, 'number');
    // Expired work is never handed out again.
    assert.equal((await request(via(hub, registration.nodeToken), 'GET', `/messages?to=worker&sessionId=${sessionId}`)).message, null);
    await stop(hub); hub = null;
    // A restart must clean by itself: the deadline lives in the row, not memory.
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token, queueTtlMs: 1 });
    const second = await request(via(hub), 'POST', '/messages', { to: 'worker', target: 'coder', text: 'second' });
    await sleep(20);
    await request(via(hub), 'GET', '/nodes');
    assert.equal((await request(via(hub), 'GET', `/messages/${second.id}`)).status, 'expired');
    // Retention prune drops aged terminal receipts so the store cannot grow forever.
    const swept = await request(via(hub), 'POST', '/queue/prune', {});
    assert.equal(typeof swept.deleted, 'number');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deferred means the target was untouched and may be handed out again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-defer-'));
  let context = await nodeHub(dir);
  let hub = context.hub;
  try {
    const input = { id: randomUUID(), to: 'worker', target: 'coder', text: 'composer is busy', mode: 'submit' };
    await request(context.admin, 'POST', '/messages', input);
    const first = (await request(via(hub, context.token), 'GET', `/messages?to=worker&sessionId=${context.sessionId}`)).message;
    assert.equal(first.attempts, 1);
    const deferred = await request(via(hub, context.token), 'POST', `/messages/${input.id}/ack`, {
      nodeId: 'worker', claimId: first.claimId, status: 'deferred',
      error: { code: 'INPUT_BUSY', message: 'Another input delivery is in progress' },
    });
    assert.equal(deferred.status, 'deferred');
    assert.equal(deferred.error.code, 'INPUT_BUSY');
    assert.equal(deferred.deferrals, 1);
    assert.equal(deferred.retryable, true, 'untouched work is explicitly re-deliverable');
    assert.equal(deferred.terminal, false);
    assert.equal(deferred.everUncertain, false, 'a deferral is not counted as network uncertainty');
    // Backoff holds it: the same poll must not hot-loop an untouched target.
    assert.equal((await request(via(hub, context.token), 'GET', `/messages?to=worker&sessionId=${context.sessionId}`)).message, null);
    await stop(hub); hub = null;
    // Deferral state is durable, and one offline edit fast-forwards the backoff
    // and spends all but the last deferral.
    withHubStore(dir, (db) => db.exec('UPDATE messages SET retry_not_before = 0, deferrals = 5'));
    context = await nodeHub(dir, {}, context.token);
    hub = context.hub;
    const node = via(hub, context.token);
    const poll = `/messages?to=worker&sessionId=${context.sessionId}`;
    const reclaimed = (await request(node, 'GET', poll)).message;
    assert.equal(reclaimed.id, input.id);
    assert.notEqual(reclaimed.claimId, first.claimId);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.deferrals, MAX_DEFERRALS - 1);
    const spent = await request(node, 'POST', `/messages/${input.id}/ack`, {
      nodeId: 'worker', claimId: reclaimed.claimId, status: 'deferred',
      error: { code: 'PENDING_DRAFT', message: 'A previous draft is pending' },
    });
    assert.equal(spent.deferrals, MAX_DEFERRALS);
    assert.equal(spent.status, 'deferred');
    assert.equal(spent.retryable, false);
    assert.equal(spent.terminal, true);
    assert.equal((await request(node, 'GET', poll)).message, null);
    // A deferral can still turn into real delivery while a claim is live.
    await request(context.admin, 'POST', '/messages', { id: randomUUID(), to: 'worker', target: 'coder', text: 'next one' });
    const next = (await request(node, 'GET', poll)).message;
    assert.notEqual(next.id, input.id);
    const late = await request(node, 'POST', `/messages/${next.id}/ack`, {
      nodeId: 'worker', claimId: next.claimId, status: 'deferred', error: { code: 'INPUT_LOCKED', message: 'Remote input is locked' },
    });
    assert.equal(late.status, 'deferred');
    await assert.rejects(request(node, 'POST', `/messages/${next.id}/ack`, {
      nodeId: 'worker', claimId: next.claimId, status: 'delivered',
      result: { status: 'submitted', outcome: 'input-submitted', messageId: next.id },
    }), { status: 409, code: 'OUTCOME_CONFLICT' });
    // Replaying the identical deferral is idempotent for a lost response.
    assert.equal((await request(node, 'POST', `/messages/${next.id}/ack`, {
      nodeId: 'worker', claimId: next.claimId, status: 'deferred', error: { code: 'INPUT_LOCKED', message: 'Remote input is locked' },
    })).status, 'deferred');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uncertain needs node evidence and only closes after budget plus chances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-uncertain-'));
  const context = await nodeHub(dir, { uncertainSettleMs: 20 });
  let hub = context.hub;
  try {
    const input = { id: randomUUID(), to: 'worker', target: 'coder', text: 'did this land?', mode: 'submit' };
    await request(context.admin, 'POST', '/messages', input);
    const node = via(hub, context.token);
    const poll = `/messages?to=worker&sessionId=${context.sessionId}`;
    const claim = (await request(node, 'GET', poll)).message;
    const ack = (status, error) => request(node, 'POST', `/messages/${input.id}/ack`, { nodeId: 'worker', claimId: claim.claimId, status, error });
    const uncertain = await ack('uncertain', { code: 'IPC_CLOSED', message: 'Terminal disconnected before acknowledging input' });
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.everUncertain, true);
    assert.equal(uncertain.settlement, 'awaiting-node-evidence');
    assert.equal(uncertain.terminal, false);
    assert.equal(uncertain.retryable, false, 'uncertain work is never re-delivered');
    assert.equal((await request(node, 'GET', poll)).message, null);
    await sleep(30);
    // The window has passed but the node has only had one chance: a deadline on
    // its own never makes a message final (M4).
    assert.equal((await request(context.admin, 'GET', `/messages/${input.id}`)).terminal, false);
    await request(node, 'GET', poll);
    await request(node, 'GET', poll);
    const closed = await request(context.admin, 'GET', `/messages/${input.id}`);
    assert.equal(closed.status, 'uncertain', 'the hub refuses to guess delivered or failed');
    assert.equal(closed.settlement, 'no-evidence-budget-exhausted');
    assert.equal(closed.terminal, true);
    assert.equal(closed.everUncertain, true);
    // Late evidence from the owning node is still allowed, because it is the only
    // party that can know, and the uncertain marker stays afterwards.
    const resolved = await request(node, 'POST', `/messages/${input.id}/ack`, {
      nodeId: 'worker', claimId: claim.claimId, status: 'delivered',
      result: { status: 'submitted', outcome: 'input-submitted', messageId: input.id },
    });
    assert.equal(resolved.status, 'delivered');
    assert.equal(resolved.settlement, 'resolved-by-node-late');
    assert.equal(resolved.everUncertain, true);
    await stop(hub); hub = null;
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    const durable = await request(via(hub), 'GET', `/messages/${input.id}`);
    assert.equal(durable.everUncertain, true, 'the ever-uncertain marker is stored, not request state');
    assert.equal(durable.settlement, 'resolved-by-node-late');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a live node id cannot be rebound by the bootstrap credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-takeover-'));
  const context = await nodeHub(dir);
  const hub = context.hub;
  try {
    const node = via(hub, context.token);
    const input = { id: randomUUID(), to: 'worker', target: 'coder', text: 'mine', mode: 'submit' };
    await request(context.admin, 'POST', '/messages', input);
    // A second process with the same node id and only the shared hub secret must
    // not displace the instance that holds the lease.
    await assert.rejects(request(context.admin, 'POST', '/nodes/worker/heartbeat', {
      instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'],
    }), { status: 403, code: 'NODE_TAKEOVER' });
    // The original instance stays authoritative: its credential still polls, and
    // the queued item is still handed to it under the original session.
    const claim = (await request(node, 'GET', `/messages?to=worker&sessionId=${context.sessionId}`)).message;
    assert.equal(claim.id, input.id);
    // The attempt is queryable rather than silently absorbed.
    const security = await request(context.admin, 'GET', '/security');
    const kinds = security.alerts.filter((alert) => alert.nodeId === 'worker').map((alert) => alert.kind);
    assert.ok(kinds.includes('NODE_TAKEOVER_BLOCKED'), kinds.join(','));
    assert.ok(kinds.includes('ADMIN_HEARTBEAT_FOR_REGISTERED_NODE'), kinds.join(','));
    const listed = (await request(context.admin, 'GET', '/nodes')).nodes.find((entry) => entry.id === 'worker');
    assert.equal(listed.security.NODE_TAKEOVER_BLOCKED.count >= 1, true);
    assert.equal(listed.instanceId, undefined, 'no instance or credential is handed to the loser');
    // A foreign credential cannot even register against the id.
    const stranger = await request(context.admin, 'POST', '/nodes/other/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    await assert.rejects(request(via(hub, stranger.nodeToken), 'POST', '/nodes/worker/heartbeat', {
      instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'],
    }), { status: 403, code: 'NODE_FORBIDDEN' });
    await assert.rejects(request(via(hub, stranger.nodeToken), 'GET', '/security'), { status: 403, code: 'ADMIN_CREDENTIAL_REQUIRED' });
    void claim;
  } finally {
    await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registration can be restricted to operator-listed node ids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-allowlist-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token, allowedNodes: ['blessed'] });
    const admin = via(hub);
    await assert.rejects(request(admin, 'POST', '/nodes/unlisted/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] }), { status: 403, code: 'NODE_NOT_ALLOWED' });
    // Authorized-but-not-yet-connected nodes may already be addressed.
    assert.equal((await request(admin, 'POST', '/messages', { to: 'blessed', target: 'coder', text: 'waiting' })).status, 'queued');
    await assert.rejects(request(admin, 'POST', '/messages', { to: 'unlisted', target: 'coder', text: 'nope' }), { status: 403, code: 'UNKNOWN_NODE' });
    const registration = await request(admin, 'POST', '/nodes/blessed/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    assert.equal(typeof registration.nodeToken, 'string');
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failure classification and targets-file permissions stay distinct', () => {
  // M5: the three codes named in the audit must never share the uncertain path.
  for (const code of ['INPUT_LOCKED', 'PENDING_DRAFT', 'INPUT_BUSY']) {
    assert.deepEqual(classifyFailure({ code, uncertain: false, message: 'untouched' }), { status: 'deferred', code });
  }
  assert.deepEqual(classifyFailure({ code: 'IPC_TIMEOUT', uncertain: true }), { status: 'uncertain', code: 'IPC_TIMEOUT' });
  assert.deepEqual(classifyFailure({ code: 'IPC_CLOSED', uncertain: true }), { status: 'uncertain', code: 'IPC_CLOSED' });
  assert.deepEqual(classifyFailure({ code: 'UNKNOWN_TARGET', uncertain: false }), { status: 'failed', code: 'UNKNOWN_TARGET' });
  // F1: a refused desktop submit touched nothing and retrying touches nothing
  // either, so it is terminal - not a deferral, and not network uncertainty.
  assert.deepEqual(classifyFailure({ code: 'CONSENT_REQUIRED', uncertain: false }), { status: 'failed', code: 'CONSENT_REQUIRED' });
  assert.equal(DEFERRABLE_CODES.has('CONSENT_REQUIRED'), false);
  assert.deepEqual(classifyFailure({ code: 'weird', uncertain: false }), { status: 'failed', code: 'DELIVERY_ERROR' });
  assert.deepEqual(classifyFailure(undefined), { status: 'failed', code: 'DELIVERY_ERROR' });
  // M2: group/world access to a file holding IPC secrets is rejected off Windows.
  assert.equal(targetFilePermissionProblem(0o600, 'linux'), null);
  assert.equal(targetFilePermissionProblem(0o700, 'darwin'), null);
  assert.match(targetFilePermissionProblem(0o644, 'linux'), /group or others/);
  assert.match(targetFilePermissionProblem(0o666, 'linux'), /group or others/);
  assert.equal(targetFilePermissionProblem(0o666, 'win32'), null, 'Windows mode bits are meaningless; ACLs are checked elsewhere');
});

test('desktop consent is carried, never inferred, and its refusal is final', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-consent-'));
  const context = await nodeHub(dir);
  const hub = context.hub;
  const node = via(hub, context.token);
  const admin = context.admin;
  const poll = `/messages?to=worker&sessionId=${context.sessionId}`;
  try {
    const unapproved = { id: randomUUID(), to: 'worker', target: 'coder', text: 'press Enter?', mode: 'submit' };
    // The default must be "not authorised" or the gate is decoration (F1).
    assert.equal((await request(admin, 'POST', '/messages', unapproved)).consent, false);
    // An explicit false is the same claim as an absent flag, so it replays the row.
    assert.equal((await request(admin, 'POST', '/messages', { ...unapproved, consent: false })).consent, false);
    await assert.rejects(request(admin, 'POST', '/messages', { ...unapproved, id: randomUUID(), consent: 'yes' }), { status: 400, code: 'INVALID_CONSENT' });
    await assert.rejects(request(admin, 'POST', '/messages', { ...unapproved, id: randomUUID(), consent: 1 }), { status: 400, code: 'INVALID_CONSENT' });
    // Replaying a stored id with a louder consent flag must not launder approval.
    await assert.rejects(request(admin, 'POST', '/messages', { ...unapproved, consent: true }), { status: 409, code: 'ID_CONFLICT' });
    const approved = { id: randomUUID(), to: 'worker', target: 'coder', text: 'press Enter, operator said so', mode: 'submit', consent: true };
    assert.equal((await request(admin, 'POST', '/messages', approved)).consent, true);

    // The refused one is queued first, so it is claimed first and arrives with the
    // flag the sender actually set.
    const first = (await request(node, 'GET', poll)).message;
    assert.equal(first.id, unapproved.id);
    assert.equal(first.consent, false);
    const refused = await request(node, 'POST', `/messages/${first.id}/ack`, {
      nodeId: 'worker', claimId: first.claimId, status: 'failed',
      error: { code: 'CONSENT_REQUIRED', message: 'ZCode desktop submit needs an explicit consent signal. Deliver mode "draft" instead, or pass consent:true from a caller with operator approval.' },
    });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error.code, 'CONSENT_REQUIRED');
    assert.equal(refused.terminal, true);
    assert.equal(refused.retryable, false);
    assert.equal(refused.attempts, 1);
    assert.equal(refused.everUncertain, false, 'nothing was ever typed, so nothing is uncertain');
    assert.match(refused.error.message, /draft/, 'relay_status has to say what to do next');

    // An approved message carries the flag through the claim to the node.
    const second = (await request(node, 'GET', poll)).message;
    assert.equal(second.id, approved.id);
    assert.equal(second.consent, true, 'the node is told what the sender claimed');
    assert.equal((await request(admin, 'GET', `/messages/${approved.id}`)).consent, true);
    const settled = await request(node, 'POST', `/messages/${second.id}/ack`, {
      nodeId: 'worker', claimId: second.claimId, status: 'delivered',
      result: { status: 'submitted', outcome: 'input-submitted', messageId: approved.id },
    });
    assert.equal(settled.status, 'delivered');
    assert.equal(settled.consent, true);
    // Neither refusal is retried: the queue is now empty rather than backed off.
    assert.equal((await request(node, 'GET', poll)).message, null);
  } finally {
    await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an operator retry re-queues live work without rewriting its history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-retry-'));
  const context = await nodeHub(dir);
  const hub = context.hub;
  const node = via(hub, context.token);
  const admin = context.admin;
  const poll = `/messages?to=worker&sessionId=${context.sessionId}`;
  try {
    // queued: nothing was ever attempted, so a retry only counts itself.
    const first = { id: randomUUID(), to: 'worker', target: 'coder', text: 'retry me', mode: 'submit' };
    await request(admin, 'POST', '/messages', first);
    const revived = await request(admin, 'POST', `/messages/${first.id}/retry`);
    assert.deepEqual(
      { ok: revived.ok, id: revived.id, status: revived.status, attempts: revived.attempts },
      { ok: true, id: first.id, status: 'queued', attempts: 0 },
      'the contract the desktop seat builds on',
    );
    assert.equal(revived.retries, 1);
    assert.equal(revived.retryEligible, true);
    assert.equal((await request(admin, 'GET', `/messages/${first.id}`)).status, 'queued');
    // Drain it, or it stays the oldest queued row and steals the polls below.
    const firstClaim = (await request(node, 'GET', poll)).message;
    assert.equal(firstClaim.id, first.id);
    await request(node, 'POST', `/messages/${first.id}/ack`, {
      nodeId: 'worker', claimId: firstClaim.claimId, status: 'delivered',
      result: { status: 'submitted', outcome: 'input-submitted', messageId: first.id },
    });
    // deferred: the backoff window really is pulled forward, or the next poll stays empty.
    const second = { id: randomUUID(), to: 'worker', target: 'coder', text: 'composer busy', mode: 'submit' };
    await request(admin, 'POST', '/messages', second);
    const claim = (await request(node, 'GET', poll)).message;
    assert.equal(claim.id, second.id);
    const deferred = await request(node, 'POST', `/messages/${second.id}/ack`, {
      nodeId: 'worker', claimId: claim.claimId, status: 'deferred',
      error: { code: 'INPUT_BUSY', message: 'Another input delivery is in progress' },
    });
    assert.equal(deferred.status, 'deferred');
    assert.equal((await request(node, 'GET', poll)).message, null, 'the deferral backoff is live before the retry');
    const again = await request(admin, 'POST', `/messages/${second.id}/retry`);
    assert.equal(again.status, 'queued');
    assert.equal(again.attempts, 1, 'the attempt history survives a retry');
    assert.equal(again.deferrals, 0, 'the budget restarts while attempts stay');
    assert.equal(again.retries, 1);
    assert.equal(again.everUncertain, undefined, 'the compact response carries no invented fields');
    const reclaimed = (await request(node, 'GET', poll)).message;
    assert.equal(reclaimed.id, second.id);
    assert.equal(reclaimed.attempts, 2);
    // A spent budget is a terminal row that a retry legitimately re-opens.
    await request(node, 'POST', `/messages/${second.id}/ack`, {
      nodeId: 'worker', claimId: reclaimed.claimId, status: 'deferred',
      error: { code: 'PENDING_DRAFT', message: 'A previous draft is pending' },
    });
    withHubStore(dir, (db) => db.prepare('UPDATE messages SET deferrals = ?, retry_not_before = ? WHERE id = ?')
      .run(MAX_DEFERRALS, Date.now() + 600000, second.id));
    const spent = await request(admin, 'GET', `/messages/${second.id}`);
    assert.equal(spent.terminal, true);
    assert.equal(spent.retryable, false);
    assert.equal(spent.retryEligible, true, 'a spent deferral budget is still retryable by an operator');
    const reopened = await request(admin, 'POST', `/messages/${second.id}/retry`);
    assert.equal(reopened.status, 'queued');
    assert.equal(reopened.terminal, false);
    assert.equal((await request(node, 'GET', poll)).message.id, second.id);
  } finally {
    await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retry revives expired work, keeps every gate, and refuses what must not re-land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-retry-gates-'));
  const context = await nodeHub(dir);
  const hub = context.hub;
  const node = via(hub, context.token);
  const admin = context.admin;
  const poll = `/messages?to=worker&sessionId=${context.sessionId}`;
  try {
    // expired: age the row out by moving its own deadline behind the clock.
    const aged = { id: randomUUID(), to: 'worker', target: 'coder', text: 'aged out', mode: 'submit' };
    await request(admin, 'POST', '/messages', aged);
    withHubStore(dir, (db) => db.prepare('UPDATE messages SET expires_at = 0 WHERE id = ?').run(aged.id));
    assert.equal((await request(admin, 'GET', `/messages/${aged.id}`)).status, 'expired');
    const revived = await request(admin, 'POST', `/messages/${aged.id}/retry`);
    assert.equal(revived.status, 'queued');
    assert.ok(revived.expiresAt - Date.now() > 30000, 'the TTL clock restarts on a revive');
    assert.equal(revived.retries, 1);
    const claim = (await request(node, 'GET', poll)).message;
    assert.equal(claim.id, aged.id);
    // delivered: settled work is never re-offered, and the row is left byte-identical.
    await request(node, 'POST', `/messages/${aged.id}/ack`, {
      nodeId: 'worker', claimId: claim.claimId, status: 'delivered',
      result: { status: 'submitted', outcome: 'input-submitted', messageId: aged.id },
    });
    const before = await request(admin, 'GET', `/messages/${aged.id}`);
    await assert.rejects(request(admin, 'POST', `/messages/${aged.id}/retry`), { status: 409, code: 'ALREADY_SETTLED' });
    assert.deepEqual(await request(admin, 'GET', `/messages/${aged.id}`), before, 'a refused retry changes nothing');
    // uncertain: only the owning node can settle it, so an operator cannot push it back.
    const risky = { id: randomUUID(), to: 'worker', target: 'coder', text: 'did it land?', mode: 'submit' };
    await request(admin, 'POST', '/messages', risky);
    const riskyClaim = (await request(node, 'GET', poll)).message;
    await request(node, 'POST', `/messages/${risky.id}/ack`, {
      nodeId: 'worker', claimId: riskyClaim.claimId, status: 'uncertain',
      error: { code: 'IPC_CLOSED', message: 'Terminal disconnected before acknowledging input' },
    });
    await assert.rejects(request(admin, 'POST', `/messages/${risky.id}/retry`), { status: 409, code: 'UNCERTAIN_NOT_RETRYABLE' });
    const stillUncertain = await request(admin, 'GET', `/messages/${risky.id}`);
    assert.equal(stillUncertain.status, 'uncertain');
    assert.equal(stillUncertain.everUncertain, true, 'retry cannot launder the sticky uncertain marker');
    assert.equal(stillUncertain.settlement, 'awaiting-node-evidence');
    assert.equal(stillUncertain.retries, 0, 'a refused retry leaves no audit trail behind');
    // delivering: a live claim belongs to that claim alone.
    const inFlight = { id: randomUUID(), to: 'worker', target: 'coder', text: 'claimed now', mode: 'submit' };
    await request(admin, 'POST', '/messages', inFlight);
    assert.equal((await request(node, 'GET', poll)).message.id, inFlight.id);
    await assert.rejects(request(admin, 'POST', `/messages/${inFlight.id}/retry`), { status: 409, code: 'CLAIM_ACTIVE' });
    assert.equal((await request(admin, 'GET', `/messages/${inFlight.id}`)).status, 'delivering');
  } finally {
    await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retry is bootstrap work, and re-queued rows respect the node depth cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-retry-auth-'));
  const context = await nodeHub(dir, { nodeQueueLimit: 1 });
  const hub = context.hub;
  const node = via(hub, context.token);
  const admin = context.admin;
  const poll = `/messages?to=worker&sessionId=${context.sessionId}`;
  try {
    const one = { id: randomUUID(), to: 'worker', target: 'coder', text: 'only room', mode: 'submit' };
    await request(admin, 'POST', '/messages', one);
    const claim = (await request(node, 'GET', poll)).message;
    await request(node, 'POST', `/messages/${one.id}/ack`, {
      nodeId: 'worker', claimId: claim.claimId, status: 'failed',
      error: { code: 'CONSENT_REQUIRED', message: 'Desktop submit needs consent; deliver draft instead' },
    });
    assert.equal((await request(admin, 'GET', `/messages/${one.id}`)).consent, false);
    const retried = await request(admin, 'POST', `/messages/${one.id}/retry`);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.consent, undefined, 'the compact response reports the retry, not the payload');
    // Re-queueing it filled the node again, so a second message is refused by the cap.
    await assert.rejects(request(admin, 'POST', '/messages', { id: randomUUID(), to: 'worker', target: 'coder', text: 'over cap', mode: 'submit' }), { status: 429, code: 'QUEUE_FULL' });
    // Retrying an already-queued row is not blocked by its own occupancy.
    assert.equal((await request(admin, 'POST', `/messages/${one.id}/retry`)).retries, 2);
    // Credentials: the node's own token buys nothing here, and neither does noise.
    await assert.rejects(request(node, 'POST', `/messages/${one.id}/retry`), { status: 403, code: 'ADMIN_CREDENTIAL_REQUIRED' });
    await assert.rejects(request(via(hub, 'x'.repeat(40)), 'POST', `/messages/${one.id}/retry`), { status: 401, code: 'UNAUTHORIZED' });
    await assert.rejects(request(admin, 'POST', `/messages/${randomUUID()}/retry`), { status: 404, code: 'NOT_FOUND' });
    await assert.rejects(request(admin, 'POST', '/messages/not-an-id/retry'), { status: 400, code: 'INVALID_ID' });
  } finally {
    await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store permissions are reported instead of assumed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-acl-'));
  const written = [];
  const original = process.stderr.write;
  let hub;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
  } finally {
    process.stderr.write = original;
  }
  try {
    assert.ok(written.some((line) => /queue store .*hub\.sqlite acl=(private|inherited)/.test(line)), written.join('|'));
    const listed = await request(via(hub), 'GET', '/nodes');
    assert.ok(['private', 'inherited'].includes(listed.store.acl), listed.store.acl);
    assert.equal(listed.store.paths.length, 2, 'the store directory and the store file are each protected');
    assert.ok(listed.store.paths.map((entry) => path.basename(entry.path)).includes('hub.sqlite'));
    for (const entry of listed.store.paths) {
      assert.equal(typeof entry.platform, 'string');
      assert.equal(typeof entry.principal, 'string');
      // A degraded result must arrive with the reason that degraded it.
      assert.equal(entry.acl === 'inherited', entry.error !== undefined, JSON.stringify(entry));
    }
    assert.equal(listed.store.paths.every((entry) => entry.acl === 'private'), listed.store.acl === 'private');
  } finally {
    await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
