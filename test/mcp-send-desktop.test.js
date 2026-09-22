'use strict';
// Wave 10 (#22 tool surface): send_desktop is the named, expedited desktop route.
// Its three disciplines are what this file exists to pin - always submit, never
// degrade, and authorization once per message. Adapters are replaced with
// recording fakes before lib/core loads, so nothing here can touch a real window,
// a real session, or spawn a process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-desk-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.OPENACOM_AGENT_ID;
delete process.env.AGENTRELAY_AGENT_ID;
delete process.env.OPENACOM_DESKTOP_CONSENT;
delete process.env.AGENTRELAY_DESKTOP_CONSENT;

const SESSIONS = {
  zcode: [{ id: 'sess-1', agent: 'zcode', title: 'desktop', workspace: 'F:/Work/desk', mtime: 9 }],
  codex: [{ id: 'c-1', agent: 'codex', title: 'cli', workspace: 'F:/Work/cli', mtime: 8 }],
};
const calls = [];
let desktopThrows = false;
const stubbed = [];
for (const name of ['zcode', 'claude', 'codex', 'opencode']) {
  const resolved = require.resolve(path.join(__dirname, '..', 'lib', 'adapters', `${name}.js`));
  stubbed.push([resolved, require.cache[resolved]]);
  const rows = SESSIONS[name] || [];
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: {
      name,
      available: () => rows.length > 0,
      list: () => rows.map((r) => ({ ...r })),
      get: (id) => { const hit = rows.find((r) => r.id === id); return hit ? { ...hit } : null; },
      messages: () => [],
      send: async (...a) => { calls.push(['send', name, a]); return 'OK sent (no-wait)'; },
      sendFresh: (...a) => { calls.push(['sendFresh', name, a]); return { id: 'new-1', reply: '' }; },
      sendDesktop: (...a) => {
        calls.push(['sendDesktop', name, a]);
        if (desktopThrows) throw new Error('CDP port 9222 refused the identity probe');
        return 'OK sent via CDP';
      },
    },
  };
}

const mcp = require('../lib/mcp');
const inbox = require('../lib/inbox');

const call = async (name, args) => (await mcp.handleMessage({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
})).result;
const text = (result) => result.content[0].text;
const reset = () => { calls.length = 0; desktopThrows = false; };

test('send_desktop without authorization is refused before the window is touched', async () => {
  reset();
  const out = await call('send_desktop', { from: 'codex:c-1', to: 'zcode:sess-1', message: 'press enter?' });
  assert.equal(out.isError, true);
  assert.match(text(out), /^CONSENT_REQUIRED:/);
  assert.match(text(out), /no draft mode/, 'the refusal does not dangle a downgrade it will not perform');
  assert.match(text(out), /OPENACOM_DESKTOP_CONSENT/);
  assert.deepEqual(calls, [], 'not one adapter method ran - no Enter, no fallback');
});

test('consent:true submits once and signs the message for the reply path', async () => {
  reset();
  const out = JSON.parse(text(await call('send_desktop', {
    from: 'codex:c-1', to: 'zcode:sess-1', message: 'operator approved this one', consent: true,
  })));
  assert.equal(out.status, 'desktop-submitted');
  assert.equal(out.delivery, 'desktop');
  assert.equal(out.sessionId, 'sess-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'sendDesktop');
  assert.equal(calls[0][1], 'zcode');
  const [sessionId, message, opts] = calls[0][2];
  assert.equal(sessionId, 'sess-1');
  assert.match(message, /\[via OpenAcom · from codex:c-1\]$/, 'the target can reply to the sender');
  assert.equal(opts.consent, true, 'the transport is told the grant was given');
});

test('the process-wide env grant is honored without a per-call flag', async () => {
  reset();
  process.env.AGENTRELAY_DESKTOP_CONSENT = '1';
  try {
    const out = JSON.parse(text(await call('send_desktop', { from: 'codex:c-1', to: 'zcode:sess-1', message: 'my own desktop' })));
    assert.equal(out.status, 'desktop-submitted');
    assert.equal(calls.length, 1);
  } finally { delete process.env.AGENTRELAY_DESKTOP_CONSENT; }
});

test('a failing desktop route is reported, never quietly rewritten', async () => {
  reset();
  desktopThrows = true;
  const out = await call('send_desktop', { from: 'codex:c-1', to: 'zcode:sess-1', message: 'will it degrade?', consent: true });
  assert.equal(out.isError, true);
  assert.match(text(out), /CDP port 9222 refused the identity probe/, 'the transport error is passed through verbatim');
  assert.ok(!/mailbox/.test(text(out)), 'no mailbox substitution is smuggled into the answer');
  assert.deepEqual(calls.map((c) => c[0]), ['sendDesktop'], 'no headless send, no fresh session, nothing else');
  assert.equal(inbox.list({}).length, 0, 'a failed submit leaves no queue row behind');
});

test('only the desktop platform is accepted, and it says so', async () => {
  reset();
  const out = await call('send_desktop', { from: 'codex:c-1', to: 'codex:c-1', message: 'not a desktop', consent: true });
  assert.equal(out.isError, true);
  assert.match(text(out), /^DESKTOP_UNSUPPORTED:/);
  assert.match(text(out), /mailbox/, 'and it points at the verb that can reach this target');
  assert.equal(calls.length, 0);
  const badTo = await call('send_desktop', { from: 'codex:c-1', to: 'qoder:boss', message: 'x', consent: true });
  assert.match(text(badTo), /invalid "to"/, 'a mailbox-only address is not a desktop target');
  const missing = await call('send_desktop', { from: 'codex:c-1', to: 'zcode:nope', message: 'x', consent: true });
  assert.match(text(missing), /target session not found on zcode/);
  assert.equal(calls.length, 0);
});

test('a non-boolean consent is a caller bug, reported as one', async () => {
  reset();
  const out = await call('send_desktop', { from: 'codex:c-1', to: 'zcode:sess-1', message: 'x', consent: 'true' });
  assert.equal(out.isError, true);
  assert.match(text(out), /INVALID_CONSENT/);
  assert.deepEqual(calls, []);
});

test('send_desktop has no knob that could soften it', async () => {
  const tools = (await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const desk = tools.find((t) => t.name === 'send_desktop');
  assert.deepEqual(Object.keys(desk.inputSchema.properties).sort(), ['consent', 'from', 'message', 'timeoutMs', 'to']);
  assert.equal(desk.inputSchema.additionalProperties, false, 'no undeclared mode/draft/wait flag can sneak in');
  assert.deepEqual(desk.inputSchema.required, ['from', 'to', 'message'], 'the desktop route always names its sender');
  assert.match(desk.description, /NEVER degrades/, 'the discipline is in the contract the model reads');
});

test('send_message(inject,desktop) shares the same consent entrance', async () => {
  reset();
  const bare = await call('send_message', { inject: true, desktop: true, from: 'codex:c-1', to: 'zcode:sess-1', message: 'same rule' });
  assert.equal(bare.isError, true);
  assert.match(text(bare), /^CONSENT_REQUIRED:/);
  assert.deepEqual(calls, [], 'and it touched nothing');
  const granted = await call('send_message', { inject: true, desktop: true, consent: true, from: 'codex:c-1', to: 'zcode:sess-1', message: 'same rule' });
  assert.equal(JSON.parse(text(granted)).status, 'desktop-submitted');
  assert.equal(calls.length, 1);
});

test('cleanup', () => {
  inbox.close();
  for (const [resolved, entry] of stubbed) {
    if (entry === undefined) delete require.cache[resolved]; else require.cache[resolved] = entry;
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  assert.equal(fs.existsSync(home), false);
});
