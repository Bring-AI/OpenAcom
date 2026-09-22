'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const COMMS = path.join(__dirname, '..', 'lib', 'comms.js');

function stubAdapter(results) {
  const calls = [];
  return {
    calls,
    name: 'stub',
    list: () => [{ id: 's1', title: 'stub session' }],
    read: () => [{ role: 'user', text: 'hi' }],
    send: (id, text, opts) => {
      calls.push({ id, text, opts });
      const next = results.length > 1 ? results.shift() : results[0];
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(id, text, opts);
      return next;
    },
  };
}

test('importing comms has no side effects', () => {
  delete require.cache[COMMS];
  const before = process._getActiveHandles().length;
  require(COMMS);
  assert.strictEqual(process._getActiveHandles().length, before);
});

test('two clients keep independent state and delegate to the injected adapter', async () => {
  const { createClient } = require(COMMS);
  const a = stubAdapter([{ status: 'accepted' }]);
  const b = stubAdapter([{ status: 'accepted' }]);
  const ca = createClient({ adapter: a });
  const cb = createClient({ adapter: b });
  const ra = await ca.send('orca:7', 'hello', { id: 'm1' });
  assert.strictEqual(ra.status, 'accepted');
  assert.strictEqual(a.calls.length, 1);
  assert.strictEqual(b.calls.length, 0);
  assert.strictEqual(a.calls[0].id, '7');
  assert.strictEqual(a.calls[0].opts.requestId, 'm1');
  assert.strictEqual(a.calls[0].opts.id, 'm1');
  assert.strictEqual(cb.history().length, 0);
  assert.strictEqual(ca.history().length, 1);
  await ca.dispose(); await cb.dispose();
});

test('Orca receipt mapping: turn_started accepted, input_accepted uncertain, refused stays refused', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({
    adapter: stubAdapter([
      { accepted: true, prompt: { stages: ['input_accepted', 'turn_started'] } },
      { accepted: true, prompt: { stages: ['input_accepted'] } },
      { accepted: false, prompt: { stages: [] } },
    ]),
  });
  const r1 = await c.send('orca:1', 'a');
  const r2 = await c.send('orca:1', 'b');
  const r3 = await c.send('orca:1', 'c');
  assert.strictEqual(r1.status, 'accepted');
  assert.strictEqual(r2.status, 'uncertain');
  assert.strictEqual(r3.status, 'refused');
  await c.dispose();
});

test('thrown errors map by uncertain flag and keep their code', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({
    adapter: stubAdapter([
      Object.assign(new Error('consent gate'), { code: 'CONSENT_REQUIRED', uncertain: false }),
      Object.assign(new Error('cdp went away'), { code: 'CDP_GONE', uncertain: true }),
    ]),
  });
  const r1 = await c.send('orca:1', 'a');
  const r2 = await c.send('orca:1', 'b');
  assert.strictEqual(r1.status, 'refused');
  assert.strictEqual(r1.code, 'CONSENT_REQUIRED');
  assert.strictEqual(r2.status, 'uncertain');
  assert.strictEqual(r2.code, 'CDP_GONE');
  await c.dispose();
});

test('history is bounded, body-free, and filterable', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({ adapter: stubAdapter([{ status: 'accepted' }]), historyLimit: 200 });
  for (let i = 0; i < 600; i++) await c.send('orca:1', 'message ' + i);
  const h = c.history();
  assert.strictEqual(h.length, 200);
  assert.strictEqual(h[0].sha12 !== undefined, true);
  assert.strictEqual(h[0].bytes > 0, true);
  assert.strictEqual('text' in h[0], false);
  assert.strictEqual('detail' in h[0] || true, true);
  assert.strictEqual(c.history({ status: 'refused' }).length, 0);
  await c.dispose();
});

test('dispose is idempotent and later calls fail loudly', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({ adapter: stubAdapter([{ status: 'accepted' }]) });
  await c.dispose();
  await c.dispose();
  assert.strictEqual(c.disposed, true);
  await assert.rejects(() => c.send('orca:1', 'x'), (e) => e.code === 'DISPOSED');
  assert.throws(() => c.history(), (e) => e.code === 'DISPOSED');
});

test('unknown addresses and unknown agents refuse without fallback', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({ adapter: stubAdapter([{ status: 'accepted' }]) });
  const bad = await c.send('no-colon-address', 'x');
  assert.strictEqual(bad.status, 'refused');
  assert.strictEqual(bad.code, 'ADDRESS_INVALID');
  const plain = createClient({});
  const unknown = await plain.send('ghostagent:1', 'x');
  assert.strictEqual(unknown.status, 'refused');
  assert.strictEqual(unknown.code, 'ADDRESS_UNKNOWN_AGENT');
  const nodeOnClient = await c.send('node:machine-a/term1', 'x');
  assert.strictEqual(nodeOnClient.status, 'refused');
  assert.strictEqual(nodeOnClient.code, 'REQUIRES_SERVICE');
  await c.dispose(); await plain.dispose();
});

test('custom address resolver claims new shapes before the builtin parser', async () => {
  const { createClient } = require(COMMS);
  const adapter = stubAdapter([{ status: 'accepted' }]);
  const c = createClient({
    adapter,
    addressResolver: (addr) => (addr.startsWith('orca:') ? { kind: 'session', agent: 'orca', sessionId: addr.slice(5) } : null),
  });
  const r = await c.send('orca:42', 'x');
  assert.strictEqual(r.status, 'accepted');
  assert.strictEqual(adapter.calls[0].id, '42');
  await c.dispose();
});

test('service records relay outcomes in the same ring; unreachable hub is uncertain', async () => {
  const { createCommunicationService } = require(COMMS);
  const prevUrl = process.env.AGENTRELAY_URL;
  process.env.AGENTRELAY_URL = 'http://127.0.0.1:1';
  try {
    const svc = createCommunicationService({ adapter: stubAdapter([{ status: 'accepted' }]) });
    const r = await svc.send('node:machine-a/term1', 'ping', { id: 'n1' });
    assert.notStrictEqual(r.status, 'accepted');
    assert.strictEqual(r.messageId, 'n1');
    assert.strictEqual(svc.history().length, 1);
    const s = await svc.send('orca:9', 'via adapter');
    assert.strictEqual(s.status, 'accepted');
    await svc.dispose();
  } finally {
    if (prevUrl === undefined) delete process.env.AGENTRELAY_URL; else process.env.AGENTRELAY_URL = prevUrl;
  }
});


test('unknown transport errors are uncertain, never retried; conflicting IDs never dispatch', async () => {
  const { createClient } = require(COMMS);
  const adapter = stubAdapter([new Error('transport lost')]);
  const c = createClient({ adapter });
  assert.equal((await c.send('pi:ssh/session', 'hello', { requestId: 'original' })).status, 'uncertain');
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].opts.requestId, 'original');
  await assert.rejects(c.send('omp:1', 'hello', { id: 'a', requestId: 'b' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(adapter.calls.length, 1);
});

test('history previews are bounded snapshots with sender and receiver identities', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({ adapter: stubAdapter([{ status: 'accepted', detail: 'd'.repeat(10000) }]), from: 'pi:sender' });
  const result = await c.send('omp:receiver', 'x'.repeat(100000));
  assert.equal(result.textPreview.length, 2000);
  assert.equal(result.truncated, true);
  assert.equal(result.detail.length, 500);
  assert.equal(result.bytes, 100000);
  result.textPreview = 'modified';
  assert.equal(c.history({ from: 'pi:sender', to: 'omp:receiver' })[0].textPreview.length, 2000);
  const rows = c.history(); rows[0].status = 'refused';
  assert.equal(c.history()[0].status, 'accepted');
  assert.equal((await c.send('omp:receiver', 'short', { from: null })).from, null);
  for (let i = 0; i < 205; i++) await c.send('pi:1', 'short');
  assert.equal(c.history().length, 200);
  const disabled = createClient({ adapter: stubAdapter([{ status: 'accepted' }]), historyLimit: 0 });
  await disabled.send('pi:1', 'hello'); assert.deepEqual(disabled.history(), []);
});

test('dispose blocks all service operations and permits an already delegated send to finish', async () => {
  const { createCommunicationService } = require(COMMS);
  let finish;
  const service = createCommunicationService({ adapter: stubAdapter([() => new Promise(resolve => { finish = resolve; })]) });
  const pending = service.send('pi:1', 'hello');
  await service.dispose();
  finish({ status: 'accepted' });
  assert.equal((await pending).status, 'accepted');
  for (const action of [() => service.send('node:remote/a', 'hello'), () => service.list(), () => service.read('1'), () => service.relayNodes(), () => service.relayStatus('id')]) {
    await assert.rejects(action(), { code: 'DISPOSED' });
  }
  assert.throws(() => service.history(), { code: 'DISPOSED' });
});

test('injected entry imports no default SDK, scanners, network or native dependency', () => {
  const { execFileSync } = require('node:child_process');
  const source = `const assert = require('node:assert/strict');
    const before = {...process.env};
    const {createClient} = require(${JSON.stringify(COMMS)});
    (async () => { const c = createClient({adapter:{name:'ssh',list:()=>[],read:()=>[],send:()=>({status:'accepted'})}});
    await c.list(); await c.read('1'); await c.send('omp:1','hello'); await c.dispose();
    assert.deepEqual({...process.env}, before);
    assert.deepEqual(Object.keys(require.cache), [${JSON.stringify(COMMS)}]); })().catch(e=>{console.error(e);process.exitCode=1});`;
  execFileSync(process.execPath, ['-e', source]);
});

test('invalid resolver and malformed remote addresses cannot fall back to the host adapter', async () => {
  const { createClient, parseAddress } = require(COMMS);
  assert.equal(parseAddress('pi:one').sessionId, 'one');
  const adapter = stubAdapter([{ status: 'accepted' }]);
  const c = createClient({ adapter, addressResolver: () => ({ kind: 'ssh', sessionId: '1' }) });
  assert.equal((await c.send('ssh:remote', 'hello')).code, 'ADDRESS_INVALID');
  const c2 = createClient({ adapter });
  assert.equal((await c2.send('node:remote', 'hello')).code, 'ADDRESS_INVALID');
  assert.equal(adapter.calls.length, 0);
  const isolated = createClient({ home: 'unused-host-home' });
  await assert.rejects(isolated.list(), { code: 'HOME_UNSUPPORTED' });
});

test('relay service uses the shared SDK against its instance connection', async () => {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'queued' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { createCommunicationService } = require(COMMS);
    const svc = createCommunicationService({ url: `http://127.0.0.1:${server.address().port}`, token: 'instance-token-012345678901234567890' });
    const result = await svc.send('node:remote/target', 'hello', { requestId: 'remote-id' });
    assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'RELAY_QUEUED');
    assert.equal(requests[0].body.id, 'remote-id'); assert.equal(requests[0].body.to, 'remote');
    assert.equal(requests[0].authorization, 'Bearer instance-token-012345678901234567890');
    await svc.relayNodes(); await svc.relayStatus('remote-id');
    assert.deepEqual(requests.map(r => r.url), ['/messages', '/nodes', '/messages/remote-id']);
    await svc.dispose();
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('accepted receipts without stage evidence are uncertain, not refusals', async () => {
  const { createClient } = require(COMMS);
  const c = createClient({ adapter: stubAdapter([
    { accepted: true },
    { accepted: true, prompt: { stages: [] } },
    { accepted: false, prompt: { stages: ['input_accepted'] } },
  ]) });
  assert.equal((await c.send('pi:1', 'hello')).status, 'uncertain');
  assert.equal((await c.send('pi:1', 'hello')).status, 'uncertain');
  assert.equal((await c.send('pi:1', 'hello')).status, 'refused');
});
