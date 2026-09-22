'use strict';
// Wave 9 (task #19): agent groups. The registry (~/.openacom/groups.json) decides
// which agent may see and touch which session, at the local MCP service layer.
// Adapters are replaced by in-memory fakes before lib/core loads, so the gate is
// exercised without reading or writing any real agent store, and a "send" never
// reaches a live session.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-groups-'));
process.env.AGENTRELAY_HOME = home;
delete process.env.AGENTRELAY_WEB_TOKEN;
delete process.env.AGENTRELAY_URL;
delete process.env.AGENTRELAY_TOKEN;
delete process.env.OPENACOM_AGENT_ID;
delete process.env.AGENTRELAY_AGENT_ID;

const SESSIONS = [
  { agent: 'zcode', id: 's-boss', title: 'boss work', workspace: 'F:/Work/boss', mtime: 5 },
  { agent: 'zcode', id: 's-burger', title: 'burger', workspace: 'F:/Work/codex/burger', mtime: 4 },
  { agent: 'zcode', id: 's-vault', title: 'vault', workspace: 'F:/Secret/vault', mtime: 3 },
  { agent: 'zcode', id: 's-loose', title: 'loose', workspace: 'F:/Other/loose', mtime: 2 },
  { agent: 'zcode', id: 's-solo', title: 'solo', workspace: 'F:/Other/solo', mtime: 1 },
  { agent: 'codex', id: 'c-x', title: 'codex app', workspace: 'F:/Work/codex/app', mtime: 6 },
];
const REGISTRY = {
  groups: { 'team-a': ['qoder', 'codex-node'], 'team-b': ['vault-bot'] },
  owners: {
    's-boss': 'qoder',
    's-vault': 'vault-bot',
    's-solo': 'solo',
    'F:/Work/codex/**': 'codex-node',
  },
};

const sent = [];
function fakeAdapter(name) {
  const rows = () => SESSIONS.filter((s) => s.agent === name);
  return {
    name,
    available: () => true,
    list: () => rows().map((r) => ({ ...r })),
    get: (id) => { const hit = rows().find((s) => s.id === id); return hit ? { ...hit } : null; },
    messages: (id) => [{ role: 'user', text: `turn in ${id}` }],
    send: async (id, message) => { sent.push(['send', id, message]); return 'OK sent'; },
    sendDesktop: (id, message, opts) => { sent.push(['desktop', id, message, opts]); return 'OK sent via CDP'; },
  };
}

const stubbed = [];
for (const name of ['zcode', 'claude', 'codex', 'opencode']) {
  const resolved = require.resolve(path.join(__dirname, '..', 'lib', 'adapters', `${name}.js`));
  stubbed.push([resolved, require.cache[resolved]]);
  const fake = name === 'codex' ? fakeAdapter('codex') : name === 'zcode' ? fakeAdapter('zcode') : {
    name, available: () => false, list: () => [], get: () => null, messages: () => [], send: async () => '',
  };
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fake };
}

const mcp = require('../lib/mcp');
const groups = require('../lib/groups');
const inbox = require('../lib/inbox');

const registryFile = path.join(home, 'groups.json');
const writeRegistry = (value) => fs.writeFileSync(registryFile, typeof value === 'string' ? value : JSON.stringify(value));
const call = async (name, args) => (await mcp.handleMessage({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
})).result;
const text = (result) => result.content[0].text;
const listedIds = async (args = {}) => (JSON.parse(text(await call('list_sessions', args)))).map((r) => r.id).sort();

test('no registry: every session is visible and marked full (feature off)', async () => {
  assert.equal(fs.existsSync(registryFile), false, 'nothing has been written yet');
  assert.deepEqual(await listedIds(), ['c-x', 's-boss', 's-burger', 's-loose', 's-solo', 's-vault']);
  const rows = JSON.parse(text(await call('list_sessions', {})));
  assert.ok(rows.every((r) => r.visibility === 'full'), 'the off state is labelled, not implied');
  const read = await call('read_session', { sessionId: 's-vault' });
  assert.equal(read.isError, false, 'reading any session still works');
  assert.equal(groups.acl(), null, 'no registry read means no acl marker either');
});

test('registry present but the caller declared no identity: legacy full visibility', async () => {
  writeRegistry(REGISTRY);
  assert.equal(groups.identity().declared, false, 'the CLI-shaped caller has no id at all');
  assert.deepEqual(await listedIds(), ['c-x', 's-boss', 's-burger', 's-loose', 's-solo', 's-vault']);
  const rows = JSON.parse(text(await call('list_sessions', {})));
  assert.ok(rows.every((r) => r.visibility === 'full'), 'an undeclared client is not silently downgraded');
  assert.equal((await call('read_session', { sessionId: 's-vault' })).isError, false);
  sent.length = 0;
  const injected = await call('send_message', { inject: true, from: 'zcode:s-boss', to: 'zcode:s-vault', message: 'legacy path' });
  assert.equal(injected.isError, false, 'an undeclared caller may still inject');
  assert.deepEqual(sent.map((s) => s[1]), ['s-vault'], 'undeclared keeps the previous unrestricted behavior');
  const legacy = groups.filterInboxRows([{ id: 'x', from_addr: 'zcode:s-vault', to_addr: 'zcode:s-loose' }]);
  assert.equal(legacy.visibility, 'full');
  assert.equal(legacy.rows.length, 1, 'and all mail stays readable by the human on the CLI');
});

test('a declared identity sees its own group, marked as filtered', async () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  try {
    assert.deepEqual(await listedIds(), ['c-x', 's-boss', 's-burger'], 'self pin, peer glob and own pin all resolve');
    const rows = JSON.parse(text(await call('list_sessions', {})));
    assert.ok(rows.every((r) => r.visibility === 'group'), 'the response says it was filtered');
    assert.equal((await call('read_session', { sessionId: 's-boss' })).isError, false);
    assert.equal((await call('read_session', { sessionId: 'c-x', agent: 'codex' })).isError, false, 'a teammate session is readable');
    // A search must not confirm a hidden session by matching its title.
    assert.deepEqual(await listedIds({ query: 'vault' }), [], 'the hidden session is not findable by search');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('cross-group read and send are refused before any side effect', async () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  sent.length = 0;
  try {
    for (const [tool, args] of [
      ['read_session', { sessionId: 's-vault' }],
      ['send_message', { inject: true, from: 'zcode:s-boss', to: 'zcode:s-vault', message: 'let me in' }],
    ]) {
      const out = await call(tool, args);
      assert.equal(out.isError, true, `${tool} must refuse`);
      assert.match(text(out), /^GROUP_FORBIDDEN:/, 'the code is in the message the client actually sees');
      assert.ok(!/vault-bot/.test(text(out)), 'the refusal never names the owning agent');
    }
    assert.equal(sent.length, 0, 'a refused send delivered nothing');
    // An unowned session is nobody's to see once the client has declared itself.
    const loose = await call('read_session', { sessionId: 's-loose' });
    assert.equal(loose.isError, true);
    assert.match(text(loose), /GROUP_FORBIDDEN/);
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('the refusal carries code GROUP_FORBIDDEN with uncertain:false', () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  try {
    let caught = null;
    try { groups.assertVisible({ id: 's-vault', agent: 'zcode', workspace: 'F:/Secret/vault' }, 'send_message'); } catch (e) { caught = e; }
    assert.ok(caught, 'a cross-group session must throw');
    assert.equal(caught.code, 'GROUP_FORBIDDEN');
    assert.equal(caught.uncertain, false, 'a policy refusal is terminal: never retried, never degraded to draft');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('declared but in no group sees only what is pinned to it', async () => {
  process.env.OPENACOM_AGENT_ID = 'solo';
  try {
    assert.deepEqual(await listedIds(), ['s-solo']);
    assert.equal((await call('read_session', { sessionId: 's-solo' })).isError, false);
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('initialize clientInfo is the second identity source, and env wins', async () => {
  assert.equal(groups.identity().declared, false, 'before the handshake nobody is declared');
  await mcp.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'qoder' } } });
  assert.deepEqual(groups.identity(), { agentId: 'qoder', declared: true, source: 'initialize' });
  assert.deepEqual(await listedIds(), ['c-x', 's-boss', 's-burger'], 'the handshake alone gates');
  process.env.OPENACOM_AGENT_ID = 'vault-bot';
  try {
    assert.equal(groups.identity().source, 'env', 'an explicit env id outranks the handshake');
    assert.deepEqual(await listedIds(), ['s-vault']);
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('the registry file is protected, and the marker is surfaced', () => {
  const acl = groups.acl();
  if (process.platform === 'win32') {
    assert.equal(acl, 'private', 'icacls ran for real on the throwaway tree and tightened it');
  } else {
    assert.ok(['private', 'inherited'].includes(acl), `unexpected marker ${acl}`);
  }
  const file = groups.GROUPS_FILE();
  assert.equal(file, registryFile);
  assert.equal(fs.existsSync(file), true);
});

test('a degraded registry acl is warned about once, not per call', async () => {
  const groupsPath = require.resolve('../lib/groups');
  const securePath = require.resolve('../lib/secure-fs');
  const realGroups = require.cache[groupsPath];
  const realSecure = require.cache[securePath];
  const { aggregateAcl, PRIVATE, INHERITED, currentPrincipal } = require('../lib/secure-fs');
  const protectedPaths = [];
  require.cache[securePath] = {
    id: securePath, filename: securePath, loaded: true,
    exports: {
      aggregateAcl, PRIVATE, INHERITED, currentPrincipal,
      protectPath: (p) => { protectedPaths.push(p); return { acl: 'inherited', path: p, platform: 'stub', principal: 'STUB\\user' }; },
    },
  };
  delete require.cache[groupsPath];
  const lines = [];
  const realError = console.error;
  console.error = (m) => lines.push(String(m));
  try {
    const fresh = require('../lib/groups');
    fresh.registry();
    fresh.registry();
    fresh.registry();
    assert.deepEqual(protectedPaths, [path.dirname(registryFile), registryFile], 'dir then file, once per process');
    assert.equal(fresh.acl(), 'inherited');
    assert.equal(lines.length, 1, `warned once, saw ${JSON.stringify(lines)}`);
    assert.match(lines[0], /kept inherited access/);
    assert.ok(lines[0].includes('groups.json'), 'the warning names the file to tighten');
  } finally {
    console.error = realError;
    require.cache[groupsPath] = realGroups;
    require.cache[securePath] = realSecure;
  }
});

test('a broken registry is a broken gate: it refuses instead of opening', async () => {
  const good = fs.readFileSync(registryFile, 'utf8');
  for (const broken of ['{ not json', '{"groups":{"team-a":"qoder"}}', '{"owners":{"x":null}}', '[]']) {
    writeRegistry(broken);
    const out = await call('list_sessions', {});
    assert.equal(out.isError, true, `must refuse with a broken gate: ${broken}`);
    assert.match(text(out), /GROUP_REGISTRY_INVALID/);
    const read = await call('read_session', { sessionId: 's-boss' });
    assert.equal(read.isError, true, 'reads are gated too');
  }
  writeRegistry(good);
  assert.equal((await call('list_sessions', {})).isError, false, 'fixing the file heals the gate, no restart');
});

test('rows created for the inbox gate', () => {
  inbox.create({ id: 'r-team', fromAddr: 'zcode:s-boss', toAddr: 'codex:c-x', agent: 'zcode', sessionId: 's-boss', text: 'within team-a' });
  inbox.create({ id: 'r-foreign', fromAddr: 'zcode:s-vault', toAddr: 'zcode:s-loose', agent: 'zcode', sessionId: 's-vault', text: 'not ours' });
  inbox.create({ id: 'r-mixed', fromAddr: 'zcode:s-boss', toAddr: 'zcode:s-vault', agent: 'zcode', sessionId: 's-boss', text: 'i sent it, i may read it' });
  assert.equal(inbox.list({}).length, 3);
});

test('inbox rows follow the same peer set, on either end of the address', async () => {
  // The handshake already declared this client as qoder, so no env id is needed.
  const mine = JSON.parse(text(await call('inbox', {})));
  assert.deepEqual(mine.map((r) => r.id).sort(), ['r-mixed', 'r-team'], 'a row is visible when either end is a peer');
  assert.ok(mine.every((r) => r.visibility === 'group'));
  assert.equal(mine.some((r) => r.id === 'r-foreign'), false, 'mail between two outsiders stays hidden');
  process.env.OPENACOM_AGENT_ID = 'vault-bot';
  try {
    const theirs = JSON.parse(text(await call('inbox', {})));
    assert.deepEqual(theirs.map((r) => r.id).sort(), ['r-foreign', 'r-mixed'], 'the other end of a mixed row also sees it');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('the qoder bridge is ungated while the address is unowned, gated once owned', async () => {
  writeRegistry({ ...REGISTRY, owners: { ...REGISTRY.owners, 's-guarded': 'vault-bot' } });
  process.env.OPENACOM_AGENT_ID = 'qoder';
  sent.length = 0;
  try {
    const open = await call('send_message', { inject: false, to: 'qoder:boss', message: 'nobody owns this address yet' });
    assert.equal(open.isError, false, 'an unowned qoder address must stay driveable - that is the point of the bridge');
    assert.equal(JSON.parse(text(open)).status, 'mailbox-delivered');
    const guarded = await call('send_message', { inject: false, to: 'qoder:s-guarded', message: 'claimed elsewhere' });
    assert.equal(guarded.isError, true);
    assert.match(text(guarded), /GROUP_FORBIDDEN/);
    assert.equal(sent.length, 0, 'a refused queue wrote nothing and delivered nothing');
  } finally {
    delete process.env.OPENACOM_AGENT_ID;
    writeRegistry(REGISTRY);
  }
});

// The mailbox is now the default send, so the peers rule has to guard the storage
// path as well - one canSee for both surfaces (#19), not a second copy.
test('the same peers rule guards the default store path', async () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  sent.length = 0;
  try {
    const mine = await call('send_message', { inject: false, to: 'zcode:s-boss', message: 'to my own session' });
    assert.equal(mine.isError, false);
    assert.equal(JSON.parse(text(mine)).status, 'mailbox-delivered');
    const before = inbox.list({ toAddr: 'zcode:s-vault' }).length;
    const foreign = await call('send_message', { inject: false, to: 'zcode:s-vault', message: 'someone else\'s inbox' });
    assert.equal(foreign.isError, true);
    assert.match(text(foreign), /GROUP_FORBIDDEN/);
    assert.equal(inbox.list({ toAddr: 'zcode:s-vault' }).length, before, 'the refused row was never stored');
    assert.equal(sent.length, 0, 'and no injection happened either');
    const unreadable = await call('send_message', { inject: false, to: 'qoder:boss', message: 'unowned is reachable' });
    assert.equal(unreadable.isError, false, 'an address the registry does not claim stays queueable');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

// Wave 10's inbox-first reads are expected to reuse this predicate rather than
// re-derive peers - so the session view and the mail view must agree by
// construction, which is what this pins.
test('one visibility rule serves sessions and mailbox rows alike', () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  try {
    const g = groups.gate();
    const foreign = { id: 's-vault', agent: 'zcode', workspace: 'F:/Secret/vault' };
    const peer = { id: 's-burger', agent: 'zcode', workspace: 'F:/Work/codex/burger' };
    assert.equal(groups.canSee(g, foreign), false);
    assert.equal(groups.canSee(g, peer), true);
    assert.equal(groups.canSee(g, { id: 's-loose', agent: 'zcode', workspace: 'F:/Other/loose' }), false, 'unowned is invisible to a declared caller');
    const allowed = groups.filterInboxRows([
      { id: 'a', from_addr: 'zcode:s-boss', to_addr: 'zcode:s-loose' },
      { id: 'b', from_addr: 'zcode:s-vault', to_addr: 'codex:c-vault' },
    ]).rows.map((r) => r.id);
    assert.deepEqual(allowed, ['a'], 'the mail filter and the session filter say the same thing');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('the desktop verb obeys the same visibility rule', async () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  sent.length = 0;
  const desktops = () => sent.filter((s) => s[0] === 'desktop');
  try {
    const mine = await call('send_desktop', { from: 'codex:c-x', to: 'zcode:s-boss', message: 'my own session', consent: true });
    assert.equal(mine.isError, false, 'a peer session stays on the expedited route');
    assert.equal(JSON.parse(text(mine)).status, 'desktop-submitted');
    assert.equal(desktops().length, 1);
    assert.equal(desktops()[0][1], 's-boss');
    assert.equal(desktops()[0][3].consent, true, 'the grant travels to the transport');
    const foreign = await call('send_desktop', { from: 'codex:c-x', to: 'zcode:s-vault', message: 'not yours', consent: true });
    assert.equal(foreign.isError, true);
    assert.match(text(foreign), /^GROUP_FORBIDDEN:/, 'an out-of-group session is refused before the transport');
    assert.equal(desktops().length, 1, 'the refused call reached no window');
    assert.equal(sent.filter((s) => s[0] === 'send').length, 0, 'and it did not fall back to a headless send');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('get_paths reports the gate state and the registry privacy', async () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  try {
    const out = JSON.parse(text(await call('get_paths', {})));
    assert.equal(out.groupsFile, registryFile);
    assert.equal(out.agentIdentity.agentId, 'qoder');
    assert.equal(out.agentIdentity.declared, true);
    assert.ok(['private', 'inherited'].includes(out.groupsAcl), 'the operator can see whether the registry is tight');
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});


test('new routed default applies the live group gate before storage and dispatch', async () => {
  process.env.OPENACOM_AGENT_ID = 'qoder';
  try {
    const count = inbox.list({ toAddr:'zcode:s-vault' }).length;
    const out = await call('send_message', { to:'zcode:s-vault', message:'routed foreign', id:'routed-group-denied' });
    assert.equal(out.isError,true); assert.match(text(out),/GROUP_FORBIDDEN/);
    assert.equal(inbox.list({toAddr:'zcode:s-vault'}).length,count);
    assert.equal(inbox.get('routed-group-denied'),null);
  } finally { delete process.env.OPENACOM_AGENT_ID; }
});

test('cleanup', () => {
  inbox.close();
  for (const [resolved, entry] of stubbed) {
    if (entry === undefined) delete require.cache[resolved]; else require.cache[resolved] = entry;
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  assert.equal(fs.existsSync(home), false);
});


