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

// POST /messages/:id/ack is the only place where a delivery becomes durable, so
// every rejection branch here is a claim that a UI side effect will not run
// twice: an acknowledgment must come from the credential issued to the node that
// holds the claim, must match that claim, must agree with the stored mode, and
// must never rewrite a final outcome.
test('acknowledgment settles a claim and final outcomes cannot be rewritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-ack-'));
  let hub;
  try {
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    const conn = { url: `http://127.0.0.1:${hub.address().port}`, token };
    const sessionId = randomUUID();
    const instanceId = randomUUID();
    const registration = await request(conn, 'POST', '/nodes/worker/heartbeat', { instanceId, sessionId, targets: ['coder'] });
    // Only this credential may settle worker's queue (H1).
    const worker = { url: conn.url, token: registration.nodeToken };
    const poll = `/messages?to=worker&sessionId=${sessionId}`;
    const ackPath = (id) => `/messages/${id}/ack`;

    const submitted = { id: randomUUID(), to: 'worker', target: 'coder', text: 'settle me once', mode: 'submit' };
    assert.equal((await request(conn, 'POST', '/messages', submitted)).status, 'queued');
    const deliveredResult = { status: 'submitted', outcome: 'input-submitted', messageId: submitted.id };
    const deliveredAck = { nodeId: 'worker', claimId: randomUUID(), status: 'delivered', result: deliveredResult };
    // Unclaimed, unknown-id and bad-status rejections need the node credential
    // first, because credential checks run before claim checks.
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), deliveredAck), { status: 409, code: 'CLAIM_CONFLICT' });
    await assert.rejects(request(worker, 'POST', ackPath(randomUUID()), { ...deliveredAck, claimId: randomUUID() }), { status: 404, code: 'NOT_FOUND' });
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), { ...deliveredAck, status: 'settled' }), { status: 400, code: 'INVALID_STATUS' });
    // The bootstrap credential is explicitly refused: knowing the hub secret does
    // not make you the node that touched the keyboard.
    await assert.rejects(request(conn, 'POST', ackPath(submitted.id), deliveredAck), { status: 403, code: 'NODE_CREDENTIAL_REQUIRED' });

    const claimed = (await request(worker, 'GET', poll)).message;
    assert.equal(claimed.status, 'delivering');
    const claimId = claimed.claimId;
    const ack = { ...deliveredAck, claimId };
    // A foreign node credential cannot settle it, and neither can the right node
    // reporting someone else's claim or the other mode.
    const stranger = await request(conn, 'POST', '/nodes/other-worker/heartbeat', { instanceId: randomUUID(), sessionId: randomUUID(), targets: ['coder'] });
    await assert.rejects(request({ url: conn.url, token: stranger.nodeToken }, 'POST', ackPath(submitted.id), ack), { status: 403, code: 'NODE_FORBIDDEN' });
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), { ...ack, nodeId: 'other-worker' }), { status: 403, code: 'NODE_FORBIDDEN' });
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), {
      ...ack, claimId: randomUUID(),
    }), { status: 409, code: 'CLAIM_CONFLICT' });
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), {
      ...ack, result: { status: 'drafted', outcome: 'input-drafted', messageId: submitted.id },
    }), { status: 400, code: 'INVALID_RESULT' });
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), {
      ...ack, result: { status: 'submitted', outcome: 'input-submitted', messageId: randomUUID() },
    }), { status: 400, code: 'INVALID_RESULT' });
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), {
      nodeId: 'worker', claimId, status: 'failed', error: { code: 'not-a-code', message: 'lowercase code' },
    }), { status: 400, code: 'INVALID_RESULT' });

    const settled = await request(worker, 'POST', ackPath(submitted.id), ack);
    assert.equal(settled.status, 'delivered');
    assert.deepEqual(settled.result, deliveredResult);
    assert.equal(settled.error, null);
    assert.equal(settled.terminal, true);
    assert.equal(settled.attempts, 1);
    // A node that lost the acknowledgment response replays it verbatim.
    assert.deepEqual(await request(worker, 'POST', ackPath(submitted.id), ack), settled);
    await assert.rejects(request(worker, 'POST', ackPath(submitted.id), {
      nodeId: 'worker', claimId, status: 'uncertain', error: { code: 'DELIVERY_UNCERTAIN', message: 'late second attempt' },
    }), { status: 409, code: 'OUTCOME_CONFLICT' });
    assert.equal((await request(worker, 'GET', poll)).message, null);

    // 'uncertain' is reported by the node, not settled by the hub: the local
    // receipt may still learn the truth and resolve it afterwards.
    const draft = { id: randomUUID(), to: 'worker', target: 'coder', text: 'leave a draft', mode: 'draft' };
    await request(conn, 'POST', '/messages', draft);
    const claimedDraft = (await request(worker, 'GET', poll)).message;
    const uncertain = await request(worker, 'POST', ackPath(draft.id), {
      nodeId: 'worker', claimId: claimedDraft.claimId, status: 'uncertain',
      error: { code: 'IPC_TIMEOUT', message: 'Terminal disconnected before acknowledging input' },
    });
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.error.code, 'IPC_TIMEOUT');
    assert.equal(uncertain.result, null);
    // M4: opening uncertainty is recorded and never final on its own.
    assert.equal(uncertain.everUncertain, true);
    assert.equal(uncertain.settlement, 'awaiting-node-evidence');
    assert.equal(uncertain.terminal, false);
    assert.equal(uncertain.retryable, false);
    const draftResult = { status: 'drafted', outcome: 'input-drafted', messageId: draft.id };
    const rescued = await request(worker, 'POST', ackPath(draft.id), {
      nodeId: 'worker', claimId: claimedDraft.claimId, status: 'delivered', result: draftResult,
    });
    assert.equal(rescued.status, 'delivered');
    assert.deepEqual(rescued.result, draftResult);
    // The node resolved it, but "this once was uncertain" must survive (M4).
    assert.equal(rescued.everUncertain, true);
    assert.equal(rescued.settlement, 'resolved-by-node');

    await stop(hub); hub = null;
    hub = await runHub({ host: '127.0.0.1', port: 0, dataDir: dir, token });
    const afterRestart = { url: `http://127.0.0.1:${hub.address().port}`, token };
    // The restart sweep only converts undelivered input; committed outcomes stay.
    for (const message of [submitted, draft]) {
      const row = await request(afterRestart, 'GET', `/messages/${message.id}`);
      assert.equal(row.status, 'delivered');
      assert.equal(row.result.outcome, message.mode === 'submit' ? 'input-submitted' : 'input-drafted');
      assert.equal(row.everUncertain, message === draft, 'the ever-uncertain marker is durable, not request state');
    }
    // A restarted node instance keeps its identity but takes a fresh session, so
    // the old session can never pull the settled messages again.
    const nextSession = randomUUID();
    const nodeConn = { url: afterRestart.url, token: registration.nodeToken };
    await request(nodeConn, 'POST', '/nodes/worker/heartbeat', { instanceId, sessionId: nextSession, targets: ['coder'] });
    const fleet = (await request(afterRestart, 'GET', '/nodes')).nodes;
    // Both registrations are durable, so both show online: the real worker plus
    // the other-worker credential used for the foreign-claim probe above.
    assert.deepEqual(fleet.filter((live) => live.online).map((live) => live.id), ['other-worker', 'worker']);
    assert.equal(fleet.find((live) => live.id === 'worker').credential.fingerprint.length, 8);
    assert.equal((await request(nodeConn, 'GET', `/messages?to=worker&sessionId=${nextSession}`)).message, null);
    await assert.rejects(request(nodeConn, 'GET', `/messages?to=worker&sessionId=${sessionId}`), { status: 409, code: 'NODE_SESSION' });
  } finally {
    if (hub) await stop(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
