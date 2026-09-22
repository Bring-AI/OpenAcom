'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const { deliver, loadTargets, inspectTerminalEndpoint } = require('../lib/delivery');
const distributedCli = require('../lib/distributed-cli');
const { consentFailure, CDP_IDENTITY, sendDesktopStrict } = require('../lib/desktop-delivery');

// The real consent gate reads the resident desktop-consent file from the
// OpenAcom home; these refusals must not inherit a real operator grant.
process.env.AGENTRELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-delivery-'));

// lib/delivery resolves its collaborators lazily, so replacing the registry
// entry is enough to keep a test away from the real ZCode session database.
function stubModule(relativeId, exports) {
  const id = require.resolve(relativeId);
  const previous = Object.prototype.hasOwnProperty.call(require.cache, id) ? require.cache[id] : undefined;
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
  return () => { if (previous) require.cache[id] = previous; else delete require.cache[id]; };
}

function captureStderr() {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  return { written, restore: () => { process.stderr.write = original; } };
}

function captureConsoleLog() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

const desktopTarget = (port) => ({ type: 'zcode', sessionId: 'task_stub', cdpPort: port });

test('a desktop target defaults to draft and never reaches the session database', async () => {
  const sends = [];
  const lookups = [];
  const restoreDesktop = stubModule('../lib/desktop-delivery', {
    ...require('../lib/desktop-delivery'),
    sendDesktopStrict: async (session, text, options) => {
      sends.push({ session, text, options });
      const status = options.mode === 'submit' ? 'submitted' : 'drafted';
      return { status, outcome: `input-${status}` };
    },
  });
  const restoreZcode = stubModule('../lib/adapters/zcode', { get: (id) => { lookups.push(id); return { id, title: 'Stub session' }; } });
  try {
    const messageId = randomUUID();
    assert.deepEqual(await deliver(desktopTarget(9222), 'hello', { messageId }), { status: 'drafted', outcome: 'input-drafted', messageId });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].options.mode, 'draft');
    assert.equal(sends[0].options.consent, false);
    assert.deepEqual(lookups, ['task_stub']);

    // An unauthorised submit must be refused before anything is looked up.
    lookups.length = 0;
    sends.length = 0;
    await assert.rejects(deliver(desktopTarget(9222), 'hello', { mode: 'submit', messageId: randomUUID() }), (error) => {
      assert.equal(error.code, 'CONSENT_REQUIRED');
      // We never touched the desktop, so this is not "state unknown".
      assert.equal(error.uncertain, false);
      assert.match(error.message, /draft/);
      assert.match(error.message, /consent/i);
      return true;
    });
    assert.deepEqual(sends, [], 'refused submit must not reach the desktop sender');
    assert.deepEqual(lookups, [], 'refused submit must not read the session database');

    // Explicit consent from the caller is the only per-call way through.
    assert.equal((await deliver(desktopTarget(9222), 'hello', { mode: 'submit', consent: true, messageId: randomUUID() })).status, 'submitted');
    assert.equal(sends[0].options.mode, 'submit');
    assert.equal(sends[0].options.consent, true);
  } finally {
    restoreDesktop();
    restoreZcode();
  }
});

test('desktop submit consent can only come from an explicit environment gate', async () => {
  const before = { ...process.env };
  try {
    for (const key of ['OPENACOM_DESKTOP_CONSENT', 'AGENTRELAY_DESKTOP_CONSENT']) delete process.env[key];
    assert.equal(consentFailure(true), null, 'consent:true is accepted');
    const refused = consentFailure(false);
    assert.ok(refused instanceof Error);
    assert.equal(refused.code, 'CONSENT_REQUIRED');
    assert.equal(refused.uncertain, false);
    for (const value of ['', '0', 'yes', 'true']) {
      process.env.OPENACOM_DESKTOP_CONSENT = value;
      assert.ok(consentFailure(false), `OPENACOM_DESKTOP_CONSENT=${JSON.stringify(value)} is not consent`);
    }
    process.env.OPENACOM_DESKTOP_CONSENT = '1';
    assert.equal(consentFailure(false), null);
    delete process.env.OPENACOM_DESKTOP_CONSENT;
    process.env.AGENTRELAY_DESKTOP_CONSENT = '1';
    assert.equal(consentFailure(false), null);
  } finally {
    for (const key of ['OPENACOM_DESKTOP_CONSENT', 'AGENTRELAY_DESKTOP_CONSENT']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

function startCdpStub(version, pages) {
  const requests = [];
  const upgrades = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const value = request.url === '/json/version' ? version : request.url === '/json' ? pages : undefined;
    if (value === undefined) { response.writeHead(404); response.end('not found'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.on('upgrade', (request) => { upgrades.push(request.url); request.socket.destroy(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, requests, upgrades,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  })));
}

const ELECTRON_VERSION = {
  Browser: 'Chrome/120.0.6099.291',
  'Protocol-Version': '1.3',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/2.4.0 Chrome/120.0.6099.291 Electron/28.2.0 Safari/537.36',
};
const PLAIN_CHROME_VERSION = {
  Browser: 'Chrome/120.0.6099.291',
  'Protocol-Version': '1.3',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.291 Safari/537.36',
};
const LOCAL_PAGE = { id: 'PAGE1', type: 'page', title: 'ZCode', url: 'file:///C:/ZCode/resources/app/index.html' };

test('an unverified CDP endpoint fails closed before the page list is read', async () => {
  const session = { id: 'task_stub', title: 'Stub session' };
  for (const [label, version, expectedRequests, expectedCode] of [
    // Something answers with a non-Electron debugger: an identity mismatch.
    ['plain chrome debugger', PLAIN_CHROME_VERSION, ['/json/version'], 'CDP_IDENTITY'],
    // Something answers but has no /json/version at all: not a debugger here.
    // That family is DESKTOP_UNAVAILABLE, which is the only one the legacy
    // sender may treat as "use the UIA transport instead" (see sendDesktop).
    ['no version endpoint', undefined, ['/json/version'], 'DESKTOP_UNAVAILABLE'],
  ]) {
    const stub = await startCdpStub(version, [LOCAL_PAGE]);
    try {
      await assert.rejects(sendDesktopStrict(session, 'secret text', {
        cdpPort: stub.port, mode: 'draft', timeoutMs: 4000,
      }), (error) => {
        assert.equal(error.code, expectedCode, `${label} must not be treated as ZCode`);
        assert.equal(error.uncertain, false, `${label} was never contacted, so it is not uncertain`);
        return true;
      });
      assert.deepEqual(stub.requests, expectedRequests, `${label}: no further CDP request after a failed identity probe`);
      assert.deepEqual(stub.upgrades, [], `${label}: no websocket was opened`);
    } finally {
      await stub.close();
    }
  }
});

test('a verified identity still has to present an identity-shaped page target', async () => {
  const session = { id: 'task_stub', title: 'Stub session' };
  const lookalike = { id: 'PAGE1', type: 'page', title: 'ZCode', url: 'https://zcode.example.invalid/app' };
  const stub = await startCdpStub(ELECTRON_VERSION, [lookalike]);
  try {
    await assert.rejects(sendDesktopStrict(session, 'secret text', {
      cdpPort: stub.port, mode: 'draft', timeoutMs: 4000,
    }), (error) => {
      assert.equal(error.code, 'DESKTOP_TARGET');
      assert.match(error.message, /rejected by the page url identity check/);
      return true;
    });
    assert.deepEqual(stub.upgrades, [], 'a lookalike page must never receive input');
  } finally {
    await stub.close();
  }
  // The default identity constants are what the strict desktop build is known by.
  assert.ok(CDP_IDENTITY.userAgent.test(ELECTRON_VERSION['User-Agent']));
  assert.equal(CDP_IDENTITY.userAgent.test(PLAIN_CHROME_VERSION['User-Agent']), false);
  assert.ok(CDP_IDENTITY.pageUrl.test(LOCAL_PAGE.url));
  assert.equal(CDP_IDENTITY.pageUrl.test(lookalike.url), false);
});

test('a passing identity probe proceeds to the page connection', async () => {
  const session = { id: 'task_stub', title: 'Stub session' };
  const stub = await startCdpStub(ELECTRON_VERSION, [LOCAL_PAGE]);
  try {
    // The stub drops the WebSocket upgrade, so delivery still fails - but it has
    // to fail at the connection stage, not at identity verification.
    await assert.rejects(sendDesktopStrict(session, 'hello', {
      cdpPort: stub.port, mode: 'draft', timeoutMs: 4000,
    }), (error) => {
      assert.notEqual(error.code, 'CDP_IDENTITY');
      assert.equal(error.uncertain, false, 'nothing was inserted, so a refused connection is not uncertain');
      return true;
    });
    assert.deepEqual(stub.requests, ['/json/version', '/json']);
    assert.equal(stub.upgrades.length, 1);
  } finally {
    await stub.close();
  }
});

test('identity overrides are honoured, but never misspelled or malformed', async () => {
  const session = { id: 'task_stub', title: 'Stub session' };
  const stub = await startCdpStub(PLAIN_CHROME_VERSION, [LOCAL_PAGE]);
  try {
    // An operator who knows their build can widen the check - the request then
    // proceeds to the connection stage instead of being refused up front.
    await assert.rejects(sendDesktopStrict(session, 'hello', {
      cdpPort: stub.port, mode: 'draft', timeoutMs: 4000, identity: { userAgent: 'Chrome/' },
    }), (error) => {
      assert.notEqual(error.code, 'CDP_IDENTITY');
      return true;
    });
    assert.equal(stub.upgrades.length, 1);
    for (const identity of [{ useragent: 'Chrome/' }, { userAgent: 42 }, { userAgent: {} }]) {
      await assert.rejects(sendDesktopStrict(session, 'hello', {
        cdpPort: stub.port, mode: 'draft', timeoutMs: 4000, identity,
      }), (error) => {
        assert.equal(error.code, 'INVALID_IDENTITY');
        assert.equal(error.uncertain, false);
        return true;
      }, `identity ${JSON.stringify(identity)} must be refused`);
    }
  } finally {
    await stub.close();
  }
});

// The legacy (non-strict) desktop sender is the route that still presses Enter
// in the live UI, so it carries the same two gates. It is synchronous, which
// makes the order of the child processes it is allowed to start the observable
// proof that nothing reaches the desktop before the gates pass.
function stubSpawns(...results) {
  const calls = [];
  const queue = [...results];
  return {
    calls,
    spawn: (command, argv) => {
      calls.push({ command, argv });
      return queue.length > 0 ? queue.shift() : { status: 1, stdout: '', stderr: '' };
    },
  };
}

// get() reads the ZCode session database below the user home, so the sender is
// pointed at a throwaway home holding a throwaway database. The real ~/.zcode is
// never opened.
function useTempZcodeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-home-'));
  const directory = path.join(home, '.zcode', 'cli', 'db');
  fs.mkdirSync(directory, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(directory, 'db.sqlite'));
  db.exec('CREATE TABLE session (id TEXT, title TEXT, directory TEXT, path TEXT)');
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('task_stub', 'Stub session', process.cwd(), process.cwd());
  db.close();
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(require('../lib/adapters/zcode').get('task_stub')?.title, 'Stub session', 'the throwaway home is not being read');
  return {
    restore: () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function useConsentFreeEnv() {
  const before = {};
  for (const key of ['OPENACOM_DESKTOP_CONSENT', 'AGENTRELAY_DESKTOP_CONSENT']) {
    before[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

test('the legacy desktop sender refuses an unconsented submit before it spawns anything', () => {
  const zcode = require('../lib/adapters/zcode');
  const consentFree = useConsentFreeEnv();
  try {
    const spawns = stubSpawns();
    assert.throws(() => zcode.sendDesktop('task_stub', 'hello', { platform: 'win32', spawn: spawns.spawn }), (error) => {
      assert.equal(error.code, 'CONSENT_REQUIRED');
      assert.equal(error.uncertain, false, 'nothing was sent, so this is not state unknown');
      assert.match(error.message, /draft/);
      return true;
    });
    assert.deepEqual(spawns.calls, [], 'a refused submit must spawn neither the probe nor the CDP tool');

    // The Windows-only guard runs first: a non-Windows caller learns the real
    // reason, and still spawns nothing.
    const elsewhere = stubSpawns();
    assert.throws(() => zcode.sendDesktop('task_stub', 'hello', { platform: 'linux', consent: true, spawn: elsewhere.spawn }), /Windows-only/);
    assert.deepEqual(elsewhere.calls, []);
  } finally {
    consentFree();
  }
});

test('an endpoint that is not ZCode is refused, not retried over the UIA transport', () => {
  const zcode = require('../lib/adapters/zcode');
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  try {
    const impostor = stubSpawns({ status: 1, stdout: '', stderr: 'CDP_IDENTITY: 127.0.0.1:9222 is not verified as the ZCode desktop debugger' });
    assert.throws(() => zcode.sendDesktop('task_stub', 'hello', { consent: true, platform: 'win32', spawn: impostor.spawn }), (error) => {
      assert.equal(error.code, 'CDP_IDENTITY');
      assert.equal(error.uncertain, false);
      return true;
    });
    assert.equal(impostor.calls.length, 1, 'the probe runs first and a refusal stops there');
    assert.equal(impostor.calls[0].argv[0], '-e', 'the only spawn is the identity probe child');
    assert.ok(!impostor.calls.some((call) => String(call.argv).includes('cdp-send.js')), 'the CDP tool must not start');
    assert.ok(!impostor.calls.some((call) => call.command === 'powershell'), 'a debugger impersonator must not be retried through UIA');

    // A probe that could not answer at all is a refusal too - silence is not a pass.
    for (const crash of [{ status: null, stdout: '', stderr: '' }, { status: 0, stdout: '', stderr: '' }, undefined]) {
      const spawns = stubSpawns(crash);
      assert.throws(() => zcode.sendDesktop('task_stub', 'hello', { consent: true, platform: 'win32', spawn: spawns.spawn }), (error) => {
        assert.equal(error.code, 'CDP_IDENTITY');
        return true;
      }, `probe result ${JSON.stringify(crash)} must not count as verified`);
      assert.equal(spawns.calls.length, 1);
    }
  } finally {
    home.restore();
    consentFree();
  }
});

test('a verified legacy send keeps its reply text and hands the port to the tool', () => {
  const zcode = require('../lib/adapters/zcode');
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  try {
    const spawns = stubSpawns(
      { status: 0, stdout: 'VERIFIED', stderr: '' },
      { status: 0, stdout: 'OK sent via CDP', stderr: '' },
    );
    const reply = zcode.sendDesktop('task_stub', 'hello', { consent: true, platform: 'win32', cdpPort: 9333, spawn: spawns.spawn });
    // lib/mcp.js keys its delivery label off this exact text.
    assert.equal(reply, 'OK sent via CDP');
    assert.equal(spawns.calls.length, 2);
    const [probe, tool] = spawns.calls;
    assert.equal(probe.argv[0], '-e');
    assert.equal(path.basename(probe.argv[2]), 'desktop-delivery.js', 'the probe reuses the strict sender module, not a second implementation');
    assert.equal(probe.argv[3], '9333', 'the probe checks the port the send will use');
    assert.match(tool.argv[0], /cdp-send\.js$/);
    assert.deepEqual(tool.argv.slice(1), ['Stub session', 'hello', '9333'], 'the tool is told which port to use');
  } finally {
    home.restore();
    consentFree();
  }
});

test('only an absent debugger endpoint may fall back to the UIA transport', () => {
  const zcode = require('../lib/adapters/zcode');
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  try {
    const spawns = stubSpawns(
      { status: 1, stdout: '', stderr: 'DESKTOP_UNAVAILABLE: CDP endpoint 127.0.0.1:9222 could not be reached: fetch failed' },
      { status: 0, stdout: 'OK sent via UIA', stderr: '' },
    );
    assert.equal(zcode.sendDesktop('task_stub', 'hello', { consent: true, platform: 'win32', spawn: spawns.spawn }), 'OK sent via UIA');
    assert.equal(spawns.calls[1].command, 'powershell');
    assert.match(String(spawns.calls[1].argv), /desktop-send\.ps1/);
  } finally {
    home.restore();
    consentFree();
  }
});

// The probe child is the part a mock cannot prove: it has to answer a live
// debugger endpoint from a process whose parent is blocked in spawnSync.
// `node -e SCRIPT A B` puts A at argv[1] - there is no script filename.
const CDP_STUB_SOURCE = 'const http=require("node:http");const v=process.argv[1],p=process.argv[2];'
  + 'http.createServer((q,s)=>{const o=q.url==="/json/version"?v:q.url==="/json"?p:null;'
  + 'if(o===null){s.writeHead(404);s.end("nope");return}s.writeHead(200,{"content-type":"application/json"});s.end(o);})'
  + '.listen(0,"127.0.0.1",function(){process.stdout.write("LISTENING "+this.address().port)})';

function startExternalCdpStub(version, pages) {
  const child = spawn(process.execPath, ['-e', CDP_STUB_SOURCE, JSON.stringify(version), JSON.stringify(pages)], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('the external CDP stub never listened')); }, 8000);
    child.stdout.on('data', (chunk) => {
      const match = /LISTENING (\d+)/.exec(String(chunk));
      if (!match) return;
      clearTimeout(timer);
      resolve({ port: Number(match[1]), close: () => new Promise((done) => { child.kill(); child.on('exit', done); }) });
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('the synchronous identity probe verifies a live endpoint and refuses an impostor', async () => {
  const { verifyCdpEndpointSync } = require('../lib/desktop-delivery');
  const trusted = await startExternalCdpStub(ELECTRON_VERSION, [LOCAL_PAGE]);
  try {
    assert.equal(verifyCdpEndpointSync(trusted.port), undefined, 'an Electron-shaped debugger endpoint passes');
  } finally {
    await trusted.close();
  }
  const impostor = await startExternalCdpStub(PLAIN_CHROME_VERSION, [LOCAL_PAGE]);
  try {
    assert.throws(() => verifyCdpEndpointSync(impostor.port), (error) => {
      assert.equal(error.code, 'CDP_IDENTITY');
      assert.equal(error.uncertain, false);
      assert.match(error.message, /does not match/);
      return true;
    });
  } finally {
    await impostor.close();
  }
  // Nothing is listening: an unavailable endpoint, which is the one case the
  // legacy sender may treat as "drive the window instead".
  assert.throws(() => verifyCdpEndpointSync(1), (error) => {
    assert.equal(error.code, 'DESKTOP_UNAVAILABLE');
    return true;
  });
});

test('the strict sender still receives mode and consent from send()', async () => {
  const calls = [];
  const restoreDesktop = stubModule('../lib/desktop-delivery', {
    ...require('../lib/desktop-delivery'),
    sendDesktopStrict: async (session, text, options) => {
      calls.push(options);
      return { status: options.mode === 'submit' ? 'submitted' : 'drafted', outcome: `input-${options.mode === 'submit' ? 'submitted' : 'drafted'}` };
    },
  });
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  try {
    const zcode = require('../lib/adapters/zcode');
    await zcode.send('task_stub', 'hello', { desktop: true, desktopStrict: true, consent: true, mode: 'submit' });
    assert.equal(calls[0].mode, 'submit');
    assert.equal(calls[0].consent, true);
    await zcode.send('task_stub', 'hello', { desktop: true, desktopStrict: true });
    // No mode here: the strict sender keeps its own draft default.
    assert.equal(calls[1].mode, undefined);
    assert.equal(calls[1].consent, false);
  } finally {
    home.restore();
    consentFree();
    restoreDesktop();
  }
});

// The adapter captures its util collaborators when it is first loaded, so a test
// that wants to steer the headless branch has to install the stub before a fresh
// require of the adapter, and undo both afterwards.
function freshZcodeWithUtil(overrides) {
  const utilId = require.resolve('../lib/util');
  const adapterId = require.resolve('../lib/adapters/zcode');
  const savedUtil = require.cache[utilId];
  const savedAdapter = require.cache[adapterId];
  require.cache[utilId] = { id: utilId, filename: utilId, loaded: true, exports: { ...savedUtil.exports, ...overrides }, children: [], paths: [] };
  delete require.cache[adapterId];
  return {
    zcode: require(adapterId),
    restore: () => {
      if (savedUtil) require.cache[utilId] = savedUtil; else delete require.cache[utilId];
      if (savedAdapter) require.cache[adapterId] = savedAdapter; else delete require.cache[adapterId];
    },
  };
}

test('the legacy transport refuses a draft instead of quietly submitting it', () => {
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  const fresh = freshZcodeWithUtil({});
  try {
    for (const [label, mode] of [['mode draft', 'draft'], ['an unknown mode', 'yolo']]) {
      const spawns = stubSpawns({ status: 0, stdout: 'VERIFIED', stderr: '' }, { status: 0, stdout: 'OK sent via CDP', stderr: '' });
      assert.throws(() => fresh.zcode.sendDesktop('task_stub', 'hello', { platform: 'win32', mode, consent: true, spawn: spawns.spawn }), (error) => {
        assert.equal(error.code, 'INVALID_MODE', `${label} must name the transport gap`);
        assert.equal(error.uncertain, false);
        assert.match(error.message, /desktopStrict/);
        return true;
      });
      assert.deepEqual(spawns.calls, [], `${label}: a refused mode must not reach the transport at all`);
    }
    // The same refusal comes back through send(), which is what the CLI calls - and
    // with the real spawnSync, so reaching the transport here would be a live send.
    assert.throws(() => fresh.zcode.send('task_stub', 'hello', { desktop: true, mode: 'draft' }), (error) => {
      assert.equal(error.code, 'INVALID_MODE');
      assert.equal(error.uncertain, false);
      return true;
    });
  } finally {
    fresh.restore();
    consentFree();
    home.restore();
  }
});

test('a desktop send through the adapter needs consent and touches nothing without it', async () => {
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  try {
    const zcode = require('../lib/adapters/zcode');
    // The strict branch is gated by the real gate, not a stub: the CDP stub below
    // records every request, so a leak would show up as a hit on the port.
    const stub = await startCdpStub(ELECTRON_VERSION, [LOCAL_PAGE]);
    try {
      await assert.rejects(zcode.send('task_stub', 'hello', {
        timeoutMs: 4000, desktop: true, desktopStrict: true, mode: 'submit', cdpPort: stub.port,
      }), (error) => {
        assert.equal(error.code, 'CONSENT_REQUIRED');
        assert.equal(error.uncertain, false);
        return true;
      });
      assert.deepEqual(stub.requests, [], 'the consent gate closes before the endpoint is probed');

      // The legacy branch is refused the same way, and spawns nothing. Both of
      // its transports reach child_process lazily (`require('child_process')
      // .spawnSync` is a default parameter, read at call time), so patching the
      // cached core module records a spawn from inside `send()` itself - the
      // route a caller actually takes - rather than only from the exported
      // `sendDesktop`.
      const spawns = stubSpawns();
      const childProcess = require('child_process');
      const realSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (...argv) => { spawns.calls.push(argv); return { status: 1, stdout: '', stderr: '' }; };
      try {
        assert.throws(() => zcode.sendDesktop('task_stub', 'hello', { platform: 'win32', spawn: spawns.spawn }), (error) => {
          assert.equal(error.code, 'CONSENT_REQUIRED');
          assert.equal(error.uncertain, false);
          return true;
        });
        assert.deepEqual(spawns.calls, [], 'no cdp-send.js child process, no identity probe');
        // Same claim through the adapter entry point, with no injected spawn.
        assert.throws(() => zcode.send('task_stub', 'hello', { timeoutMs: 4000, cdpPort: stub.port }), (error) => {
          assert.equal(error.code, 'CONSENT_REQUIRED', 'a plain zcode send defaults to the desktop route');
          return true;
        });
        assert.deepEqual(spawns.calls, [], 'tools/cdp-send.js and desktop-send.ps1 were never launched');
      } finally {
        childProcess.spawnSync = realSpawnSync;
      }
      assert.equal(childProcess.spawnSync, realSpawnSync, 'the recorder is removed before the stub shuts down');
    } finally {
      await stub.close();
    }
  } finally {
    consentFree();
    home.restore();
  }
});

test('the headless route is not gated - it is the explicit way out', () => {
  const home = useTempZcodeHome();
  const consentFree = useConsentFreeEnv();
  const noCli = freshZcodeWithUtil({ resolveZcodeCli: () => null });
  try {
    // No consent anywhere in the environment, and the headless branch still runs:
    // it fails on the missing CLI, which is proof it was reached and not refused.
    assert.throws(() => noCli.zcode.send('task_stub', 'hello', { desktop: false }), (error) => {
      assert.notEqual(error.code, 'CONSENT_REQUIRED', '--no-desktop is the documented escape hatch');
      assert.match(error.message, /zcode CLI \(zcode\.cjs\) not found/);
      return true;
    });
  } finally {
    noCli.restore();
  }
  // A missing provider config is reported as such, never as a silent success.
  const noConfig = freshZcodeWithUtil({
    resolveZcodeCli: () => 'C:/fake/zcode.cjs',
    zcodeConfigPath: () => path.join(os.tmpdir(), 'openacom-no-such-config.json'),
  });
  try {
    assert.throws(() => noConfig.zcode.send('task_stub', 'hello', { desktop: false }), /provider config/);
  } finally {
    noConfig.restore();
    consentFree();
    home.restore();
  }
});

test('a stale or unsafe terminal endpoint is reported instead of reused', async () => {
  const messageId = randomUUID();
  if (process.platform === 'win32') {
    const absent = `\\\\.\\pipe\\openacom-${randomBytes(16).toString('hex')}`;
    await assert.rejects(deliver({ type: 'terminal', socket: absent, secret: 'a'.repeat(64) }, 'hello', { messageId }), (error) => {
      assert.equal(error.code, 'DESCRIPTOR_STALE');
      assert.equal(error.uncertain, false);
      assert.match(error.message, /not present/);
      return true;
    });
    // A live endpoint must not be blocked by the new check, and a terminal
    // target keeps its historical submit default (H2 is desktop-only).
    const pipe = `\\\\.\\pipe\\openacom-${randomBytes(16).toString('hex')}`;
    const received = [];
    const server = net.createServer((client) => {
      client.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8'));
        received.push(request);
        const status = request.mode === 'submit' ? 'submitted' : 'drafted';
        client.end(JSON.stringify({ ok: true, status, outcome: `input-${status}`, messageId: request.messageId }) + '\n');
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    try {
      const target = { type: 'terminal', socket: pipe, secret: 'a'.repeat(64) };
      assert.equal((await deliver(target, 'hello', { messageId })).outcome, 'input-submitted');
      assert.equal((await deliver(target, 'hello', { mode: 'draft', messageId: randomUUID() })).outcome, 'input-drafted');
      assert.deepEqual(received.map((request) => request.mode), ['submit', 'draft']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-sock-'));
    try {
      fs.chmodSync(dir, 0o700);
      const missing = path.join(dir, 'gone.sock');
      await assert.rejects(deliver({ type: 'terminal', socket: missing, secret: 'a'.repeat(64) }, 'hello', { messageId }), { code: 'DESCRIPTOR_STALE', uncertain: false });
      const regular = path.join(dir, 'regular');
      fs.writeFileSync(regular, 'x');
      await assert.rejects(deliver({ type: 'terminal', socket: regular, secret: 'a'.repeat(64) }, 'hello', { messageId }), { code: 'DESCRIPTOR_ANOMALY', uncertain: false });
      const groupReadable = path.join(dir, 'loose.sock');
      const loose = net.createServer();
      await new Promise((resolve) => loose.listen(groupReadable, resolve));
      fs.chmodSync(groupReadable, 0o644);
      await assert.rejects(deliver({ type: 'terminal', socket: groupReadable, secret: 'a'.repeat(64) }, 'hello', { messageId }), (error) => {
        assert.equal(error.code, 'DESCRIPTOR_PERMISSION');
        assert.match(error.message, /other local users/);
        return true;
      });
      await new Promise((resolve) => loose.close(resolve));
      const okSocket = path.join(dir, 'ok.sock');
      const good = net.createServer();
      await new Promise((resolve) => good.listen(okSocket, resolve));
      fs.chmodSync(okSocket, 0o600);
      await new Promise((resolve) => good.close(resolve));
      await assert.rejects(deliver({ type: 'terminal', socket: okSocket, secret: 'a'.repeat(64) }, 'hello', { messageId }), { code: 'DESCRIPTOR_STALE' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// The real Unix branch cannot run here, so the stat results are injected.
test('the endpoint check classifies every Unix descriptor state', () => {
  const thrown = (code) => () => { throw Object.assign(new Error(code), { code }); };
  const socket = (mode) => ({ isSocket: () => true, mode });
  const regular = (mode) => ({ isSocket: () => false, mode });
  const probe = (found, parent) => inspectTerminalEndpoint('/run/user/1000/openacom/input.sock', {
    platform: 'linux',
    exists: () => true,
    lstat: () => found,
    stat: () => parent,
  });
  assert.equal(probe(socket(0o140600), { mode: 0o040700 }), null, 'a private socket in a private directory is usable');
  assert.equal(inspectTerminalEndpoint('/nope/input.sock', { platform: 'linux', lstat: thrown('ENOENT') }).code, 'DESCRIPTOR_STALE');
  assert.equal(inspectTerminalEndpoint('/nope/input.sock', { platform: 'linux', lstat: thrown('EACCES') }).code, 'DESCRIPTOR_STALE');
  assert.equal(inspectTerminalEndpoint('/nope/input.sock', { platform: 'linux', lstat: thrown('EIO') }).code, 'DESCRIPTOR_ANOMALY');
  assert.match(probe(regular(0o100644), { mode: 0o040700 }).message, /is not a socket \(mode 0644\)/);
  assert.match(probe(socket(0o140666), { mode: 0o040700 }).message, /mode 0666, so other local users/);
  assert.match(probe(socket(0o140600), { mode: 0o041777 }).message, /can replace input\.sock/);
  assert.equal(inspectTerminalEndpoint('', { platform: 'linux' }).code, 'INVALID_TARGET');
  const windows = (present) => inspectTerminalEndpoint('\\\\.\\pipe\\openacom-abc', { platform: 'win32', exists: () => present });
  assert.equal(windows(false).code, 'DESCRIPTOR_STALE');
  assert.equal(windows(true), null);
});

test('a terminal target that kept inherited access warns on every path that uses it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-targets-'));
  const file = path.join(dir, 'targets.json');
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\openacom-${randomBytes(16).toString('hex')}`
    : path.join(dir, 'input.sock');
  const stderr = captureStderr();
  try {
    fs.writeFileSync(file, JSON.stringify({
      loose: { type: 'terminal', socket, secret: 'b'.repeat(64), acl: 'inherited' },
    }) + '\n');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    const targets = loadTargets(file);
    assert.equal(targets.loose.acl, 'inherited');
    assert.match(stderr.written.join(''), /acl: "inherited"/);
    assert.equal(stderr.written.join('').includes('b'.repeat(64)), false, 'the secret must never be echoed');

    // A descriptor whose acl marker is not a known value is refused outright.
    fs.writeFileSync(file, JSON.stringify({ odd: { type: 'terminal', socket, secret: 'b'.repeat(64), acl: 'maybe' } }) + '\n');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    assert.throws(() => loadTargets(file), (error) => {
      assert.equal(error.code, 'INVALID_CONFIG');
      assert.match(error.message, /acl must be private or inherited/);
      return true;
    });

    const messageId = randomUUID();
    stderr.written.length = 0;
    await assert.rejects(deliver(targets.loose, 'hello', { messageId }), (error) => {
      assert.match(error.code, /^DESCRIPTOR_STALE$|^IPC_/);
      return true;
    });
    assert.match(stderr.written.join(''), /without tightened permissions/);
  } finally {
    stderr.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relay send only puts a consent claim on the wire when it was asked for', async () => {
  const calls = [];
  const restoreDistributed = stubModule('../lib/distributed', {
    request: async (conn, method, url, body) => { calls.push({ conn, method, url, body }); return { ok: true }; },
    runHub: () => { throw new Error('a hub must not start here'); },
    runNode: () => { throw new Error('a node must not start here'); },
  });
  const log = captureConsoleLog();
  try {
    await distributedCli.run(['send', 'worker', 'coder', 'hello', '--id', 'aaaaaaaa-0000-4000-8000-000000000001']);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/messages');
    assert.equal(Object.hasOwn(calls[0].body, 'consent'), false, 'no flag means no claim, not an implied false');

    await distributedCli.run(['send', 'worker', 'coder', 'hello', '--consent', 'true', '--mode', 'submit']);
    assert.equal(calls[1].body.consent, true);
    await distributedCli.run(['send', 'worker', 'coder', 'hello', '--consent', 'false']);
    assert.equal(calls[2].body.consent, false);

    log.restore();
    for (const value of ['yes', '1', 'TRUE']) {
      await assert.rejects(distributedCli.run(['send', 'worker', 'coder', 'hello', '--consent', value]), /--consent must be true or false/, `--consent ${value} is not a boolean`);
    }
  } finally {
    log.restore();
    restoreDistributed();
  }
});

// The log of a detached turn is that turn's complete output, so the permissions
// it is created with are a disclosure decision, not cosmetics. The recorder below
// is what proves the *request* (Windows ignores a mkdir/open mode, so asserting
// real bits here would prove nothing); the next test runs the real thing.
test('a detached zcode turn asks for a private log tree and protects it once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-loghome-'));
  const dir = path.join(home, '.openacom', 'logs');
  const zcode = require('../lib/adapters/zcode');
  const calls = { mkdir: [], open: [], close: [], protect: [], spawn: [], unref: 0 };
  const deps = {
    home: () => home,
    fsImpl: {
      mkdirSync: (target, options) => { calls.mkdir.push({ target, options }); },
      openSync: (target, flags, mode) => { calls.open.push({ target, flags, mode }); return 41; },
      closeSync: (fd) => { calls.close.push(fd); },
    },
    protect: (target, options) => {
      calls.protect.push({ target, options });
      return { acl: 'private', path: target, platform: 'test', principal: 'test\\user' };
    },
    spawn: (execPath, argv, options) => {
      calls.spawn.push({ execPath, argv, options });
      return { unref: () => { calls.unref += 1; } };
    },
  };
  const first = zcode.spawnDetached(['-e', '0'], home, deps);
  const second = zcode.spawnDetached(['-e', '0'], home, deps);

  assert.equal(calls.mkdir.length, 2);
  for (const call of calls.mkdir) {
    assert.equal(call.target, dir, 'the log tree is built under the injected home, never the real ~/.openacom');
    assert.equal(call.options.recursive, true);
    assert.equal(call.options.mode, 0o700, 'a 0755 logs directory is readable by every local account');
  }
  assert.equal(calls.open.length, 2);
  for (const call of calls.open) {
    assert.equal(call.flags, 'a');
    assert.equal(call.mode, 0o600, 'a 0644 turn log leaks the whole turn to other local accounts');
    assert.equal(path.dirname(call.target), dir);
  }
  for (const file of [first, second]) assert.equal(path.dirname(file), dir);

  // One protection for the directory, not one per send: the memo is what keeps
  // icacls off the hot path.
  assert.equal(calls.protect.length, 1, 'protectPath ran per send instead of once per directory');
  assert.equal(calls.protect[0].target, dir);
  assert.deepEqual(calls.protect[0].options, { directory: true });
  assert.equal(zcode.logsAcl().acl, 'private', 'the marker the caller can read is the one protectPath returned');

  assert.equal(calls.spawn.length, 2);
  assert.equal(calls.spawn[0].options.detached, true);
  assert.deepEqual(calls.spawn[0].options.stdio, ['ignore', 41, 41], 'both streams go to the log descriptor');
  assert.equal(calls.unref, 2);
  assert.deepEqual(calls.close, [41, 41]);
});

test('the real log tree goes through secure-fs and reports what it actually got', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openacom-loghome-'));
  const dir = path.join(home, '.openacom', 'logs');
  const zcode = require('../lib/adapters/zcode');
  const spawned = [];
  const stderr = captureStderr();
  let log;
  try {
    log = zcode.spawnDetached(['-e', '0'], home, {
      home: () => home,
      spawn: (execPath, argv, options) => { spawned.push(options); return { unref() {} }; },
    });
  } finally {
    stderr.restore();
  }
  assert.equal(fs.statSync(dir).isDirectory(), true, 'the directory really exists - protectPath cannot protect a path it never created');
  assert.equal(fs.existsSync(log), true, 'the log file really exists');
  const fd = spawned[0].stdio[1];
  assert.equal(typeof fd, 'number');
  assert.ok(fd >= 0);
  assert.deepEqual(spawned[0].stdio, ['ignore', fd, fd]);

  const marker = zcode.logsAcl();
  assert.equal(marker.path, dir, 'the marker names the tree it protected');
  if (process.platform === 'win32') {
    // A real icacls ran against this temp tree. Anything other than a private
    // descriptor is a finding on this machine, not a test artefact.
    assert.equal(marker.acl, 'private', `the log tree kept inherited access: ${marker.error || 'no error reported'}`);
  } else {
    assert.equal(marker.acl, 'private', `chmod could not make the tree private: ${marker.error || 'no error reported'}`);
    assert.equal(fs.statSync(dir).mode & 0o077, 0, 'group or other still hold the logs directory');
    assert.equal(fs.statSync(log).mode & 0o077, 0, 'group or other still hold the turn log');
  }
});
