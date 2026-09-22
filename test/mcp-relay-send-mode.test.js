'use strict';
// Wave 6.1: relay_send must stop hardcoding an explicit mode, or the
// destination's desktop-draft safety default can never fire for the most common
// caller (an agent). Only the wire shape of the forwarded body is asserted here;
// lib/distributed.js and lib/delivery.js stay untouched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-mode-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.AGENTRELAY_URL;
delete process.env.AGENTRELAY_TOKEN;

const mcp = require('../lib/mcp');

// Record what relay_send puts on the wire instead of talking to a hub: starting
// one here would be another member's long-running process, and the question is
// only what we send.
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

test('an omitted mode leaves the field off the request body entirely', async () => {
  await withDistributedRecorder(async (calls) => {
    const out = await sendVia({ to: 'machine-a', target: 'desktop', text: 'hello' });
    assert.equal(out.isError, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { to: 'machine-a', target: 'desktop', text: 'hello' }, 'no implicit mode:submit, and nothing else invented');
    assert.ok(!('mode' in calls[0].body), 'absent mode is what lets the node default desktop to draft');
  });
});

test('an explicit mode is forwarded verbatim', async () => {
  await withDistributedRecorder(async (calls) => {
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'press enter', mode: 'submit' });
    assert.equal(calls[0].body.mode, 'submit');
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'just paste', mode: 'draft' });
    assert.equal(calls[1].body.mode, 'draft');
  });
});

test('mode null is absent, and a bogus mode is sent as-is for the hub to reject', async () => {
  await withDistributedRecorder(async (calls) => {
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'null mode', mode: null });
    assert.ok(!('mode' in calls[0].body), 'null is not a mode');
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'typo', mode: 'submmit' });
    assert.equal(calls[1].body.mode, 'submmit', 'we must not launder a caller mistake into our own default');
  });
});

test('consent keeps its own rule next to the new mode handling', async () => {
  await withDistributedRecorder(async (calls) => {
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'no consent given' });
    assert.ok(!('consent' in calls[0].body), 'unapproved stays unapproved - the field is absent, never true');
    await sendVia({ to: 'machine-a', target: 'desktop', text: 'draft plus consent', mode: 'draft', consent: false });
    assert.deepEqual(calls[1].body, { to: 'machine-a', target: 'desktop', text: 'draft plus consent', mode: 'draft', consent: false });
    const bad = await sendVia({ to: 'machine-a', target: 'desktop', text: 'lenient', consent: 'true' });
    assert.equal(bad.isError, true);
    assert.equal(calls.length, 2, 'a rejected call never reaches the hub');
  });
});

test('relay_send advertises mode with no misleading schema default', async () => {
  const tools = (await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const relay = tools.find((t) => t.name === 'relay_send');
  assert.deepEqual(Object.keys(relay.inputSchema.properties.mode).sort(), ['description', 'enum', 'type'], 'no default key - a JSON-Schema default never fills a request body');
  assert.deepEqual(relay.inputSchema.properties.mode.enum, ['submit', 'draft']);
  assert.match(relay.inputSchema.properties.mode.description, /[Dd]raft/, 'the description says who gets the safer default');
  assert.match(relay.description, /[Oo]mit mode/, 'the tool text tells the caller that naming a mode costs the default');
});

// Pinned so a rename cannot slip past test/readme-claims.test.js silently: that
// gate fails README-side when a declared tool name is missing from the document.
test('the declared MCP tool names are exactly the documented set', async () => {
  const tools = (await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'ack_message', 'get_paths', 'inbox', 'list_sessions', 'post_message', 'read_session', 'relay_nodes', 'relay_send', 'relay_status', 'send_desktop', 'send_message',
  ], 'post_message joined in wave 8 and send_desktop in wave 10; anything else moving is a rename');
});

test('cleanup', () => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  assert.ok(true);
});
